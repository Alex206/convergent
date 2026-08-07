'use strict';

const { workspaceRevision, assertGitRepository } = require('./revision');
const { SessionFactory } = require('../copilot/session-factory');

function taskPrompt(task) {
  return [
    `Task ${task.id}: ${task.title}`,
    '',
    task.description,
    '',
    'Acceptance criteria:',
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
  ].join('\n');
}

function formatFindings(findings) {
  return findings
    .map((finding, index) => {
      const location = finding.file ? ` (${finding.file})` : '';
      return `${index + 1}. [${finding.severity}] ${finding.title}${location}: ${finding.description}`;
    })
    .join('\n');
}

async function requireReport(session, sink, prompt, toolName) {
  sink.value = null;
  await session.sendAndWait({ prompt });
  if (sink.value) return sink.value;

  await session.sendAndWait({
    prompt: `You did not call ${toolName}. Complete the current pass now and call ${toolName} exactly once with your final structured result.`,
  });
  if (!sink.value) {
    throw new Error(`Agent failed to call required tool ${toolName} after a retry.`);
  }
  return sink.value;
}

class ConvergentEngine {
  constructor({ client, sdk, workspace, models, permissionHandler, userInputHandler, ui, maxWorkerPasses = 8, maxReviewerCycles = 3, signal, revisionProvider = workspaceRevision }) {
    this.client = client;
    this.sdk = sdk;
    this.workspace = workspace;
    this.models = models;
    this.permissionHandler = permissionHandler;
    this.userInputHandler = userInputHandler;
    this.ui = ui;
    this.maxWorkerPasses = maxWorkerPasses;
    this.maxReviewerCycles = maxReviewerCycles;
    this.signal = signal;
    this.revisionProvider = revisionProvider;
    this.runId = `convergent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sessions = [];
  }

  checkCancelled() {
    if (this.signal?.aborted) throw new Error('Convergent workflow cancelled by user.');
  }

  async run(userRequest) {
    await assertGitRepository(this.workspace);
    this.checkCancelled();

    const factory = new SessionFactory({
      client: this.client,
      sdk: this.sdk,
      workspace: this.workspace,
      models: this.models,
      permissionHandler: this.permissionHandler,
      userInputHandler: this.userInputHandler,
      ui: this.ui,
      runId: this.runId,
    });

    this.ui.phase('Planning', 'Coordinator is inspecting the repository and preparing the implementation plan.');
    const coordinator = await factory.createCoordinator();
    this.sessions.push(coordinator.session);

    const plan = await requireReport(
      coordinator.session,
      coordinator.sink,
      `User request:\n\n${userRequest}\n\nInspect the repository, clarify only material ambiguities, then submit the implementation plan with report_plan.`,
      'report_plan',
    );
    this.ui.plan(plan);

    for (let index = 0; index < plan.tasks.length; index += 1) {
      this.checkCancelled();
      const task = plan.tasks[index];
      this.ui.taskStarted(task, index + 1, plan.tasks.length);
      await this.runTask(factory, task, `${index + 1}-${task.id}`);
      this.ui.taskCompleted(task);
      await coordinator.session.sendAndWait({
        prompt: `Task ${task.id} (${task.title}) completed and passed the strong review. Keep this result in the overall run context. Do not edit files and do not submit a new plan unless explicitly asked.`,
      });
    }

    this.ui.phase('Complete', `All ${plan.tasks.length} implementation tasks converged and passed strong review.`);
    return plan;
  }

  async runTask(factory, task, taskSessionKey = task.id) {
    let workerA;
    let workerB;
    let reviewer;

    try {
      workerA = await factory.createWorker(taskSessionKey, 'A');
      this.sessions.push(workerA.session);
      workerB = await factory.createWorker(taskSessionKey, 'B');
      this.sessions.push(workerB.session);
      reviewer = await factory.createReviewer(taskSessionKey);
      this.sessions.push(reviewer.session);
      const initial = await this.runWorkerPass(workerA, task, 'IMPLEMENT', null);
      this.ui.passResult('A', initial.report, initial.changed, initial.revision);
      if (initial.report.verdict === 'blocked') {
        throw new Error(`Worker A is blocked: ${initial.report.summary}`);
      }

      let nextWorker = workerB;
      let convergence = await this.convergeWorkers(task, workerA, workerB, nextWorker, initial);

      for (let reviewCycle = 1; reviewCycle <= this.maxReviewerCycles; reviewCycle += 1) {
        this.checkCancelled();
        const beforeReview = await this.revisionProvider(this.workspace);
        const review = await requireReport(
          reviewer.session,
          reviewer.sink,
          [
            taskPrompt(task),
            '',
            `Worker A and Worker B both approved current revision ${beforeReview.slice(0, 12)}.`,
            reviewCycle > 1 ? 'This is a subsequent strong-review cycle. Re-check every finding you raised earlier, then perform a complete review of the current task.' : 'Perform the first complete strong review of this task.',
            'Do not edit files. Call report_review exactly once.',
          ].join('\n'),
          'report_review',
        );
        const afterReview = await this.revisionProvider(this.workspace);
        if (beforeReview !== afterReview) {
          throw new Error('Strong reviewer changed the workspace despite the read-only contract.');
        }
        this.ui.reviewResult(review, reviewCycle);

        if (review.verdict === 'clean') return;
        if (review.verdict === 'blocked') {
          throw new Error(`Strong reviewer is blocked: ${review.summary}`);
        }
        if (!review.findings?.length) {
          throw new Error('Strong reviewer returned findings without any actionable findings.');
        }
        if (reviewCycle === this.maxReviewerCycles) {
          throw new Error(`Strong review still has findings after ${this.maxReviewerCycles} remediation cycles.`);
        }

        this.ui.phase('Remediation', `Strong reviewer returned ${review.findings.length} finding(s); Worker A starts remediation, then A/B convergence repeats.`);
        const remediation = await this.runWorkerPass(workerA, task, 'FIX_STRONG_REVIEW_FINDINGS', review.findings);
        this.ui.passResult('A', remediation.report, remediation.changed, remediation.revision);
        if (remediation.report.verdict === 'blocked') {
          throw new Error(`Worker A is blocked during strong-review remediation: ${remediation.report.summary}`);
        }
        convergence = await this.convergeWorkers(task, workerA, workerB, workerB, remediation);
        void convergence;
      }
    } finally {
      const taskSessions = [workerA?.session, workerB?.session, reviewer?.session].filter(Boolean);
      await Promise.allSettled(taskSessions.map((session) => session.disconnect()));
      this.sessions = this.sessions.filter((session) => !taskSessions.includes(session));
    }
  }

  async convergeWorkers(task, workerA, workerB, nextWorker, previousPass) {
    const approvals = new Map();
    if (!previousPass.changed && previousPass.report.verdict === 'clean') {
      approvals.set(previousPass.worker, previousPass.revision);
    }

    let currentRevision = previousPass.revision;
    let worker = nextWorker;

    for (let pass = 1; pass <= this.maxWorkerPasses; pass += 1) {
      this.checkCancelled();
      const result = await this.runWorkerPass(worker, task, 'REVIEW_AND_FIX', null);
      this.ui.passResult(worker.name, result.report, result.changed, result.revision);

      if (result.report.verdict === 'blocked') {
        throw new Error(`Worker ${worker.name} is blocked: ${result.report.summary}`);
      }

      if (result.changed) {
        approvals.clear();
        currentRevision = result.revision;
      } else if (result.report.verdict === 'clean') {
        approvals.set(worker.name, result.revision);
      } else if (result.report.verdict === 'changed') {
        throw new Error(`Worker ${worker.name} reported CHANGED but the workspace revision did not change.`);
      }

      if (approvals.get('A') === currentRevision && approvals.get('B') === currentRevision) {
        this.ui.converged(currentRevision, pass);
        return currentRevision;
      }

      worker = worker === workerA ? workerB : workerA;
    }

    throw new Error(`Workers did not converge within ${this.maxWorkerPasses} review/fix passes.`);
  }

  async runWorkerPass(worker, task, mode, findings) {
    const before = await this.revisionProvider(this.workspace);
    const prompt = [
      `MODE: ${mode}`,
      taskPrompt(task),
      '',
      `Current workspace revision fingerprint: ${before}`,
      findings?.length ? `\nStrong reviewer findings to verify and address:\n${formatFindings(findings)}` : '',
      '',
      mode === 'IMPLEMENT'
        ? 'Implement this task completely. Inspect the existing repository first and follow its patterns.'
        : 'Review the CURRENT repository state independently. Fix every valid actionable issue you find; do not merely comment on it.',
      'Run relevant checks. Then call report_pass exactly once.',
    ].join('\n');

    const report = await requireReport(worker.session, worker.sink, prompt, 'report_pass');
    const after = await this.revisionProvider(this.workspace);
    const changed = before !== after;

    if (report.verdict === 'clean' && changed) {
      throw new Error(`Worker ${worker.name} reported CLEAN but changed the workspace.`);
    }
    if (report.verdict === 'changed' && !changed) {
      throw new Error(`Worker ${worker.name} reported CHANGED but the workspace revision is identical.`);
    }

    return { worker: worker.name, report, changed, revision: after };
  }

  async stop() {
    await Promise.allSettled(this.sessions.map((session) => session.abort?.()));
    await Promise.allSettled(this.sessions.map((session) => session.disconnect?.()));
    this.sessions = [];
  }
}

module.exports = { ConvergentEngine, taskPrompt, requireReport, formatFindings };
