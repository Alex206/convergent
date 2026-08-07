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

function formatPeerPass(peerPass) {
  if (!peerPass?.report) return '';
  const findings = peerPass.report.findings?.length
    ? `\nPeer findings:\n${peerPass.report.findings.map((finding) => `- ${finding}`).join('\n')}`
    : '\nPeer findings: none reported.';
  const checks = peerPass.report.checks?.length
    ? `\nPeer checks:\n${peerPass.report.checks.map((check) => `- ${check}`).join('\n')}`
    : '';

  return [
    `Previous peer pass from Worker ${peerPass.worker}:`,
    `- verdict: ${peerPass.report.verdict}`,
    `- workspace changed: ${peerPass.changed ? 'yes' : 'no'}`,
    `- resulting revision: ${peerPass.revision}`,
    `- summary: ${peerPass.report.summary ?? ''}`,
    findings,
    checks,
    '',
    'Treat this as the peer worker\'s explicit technical position. Challenge it where warranted rather than simply agreeing with it. Verify claims against the current repository state, but do not repeat inspection that your retained context already makes unnecessary.',
  ].join('\n');
}

async function sendAndCaptureReport(session, sink, prompt, timeoutMs) {
  try {
    await session.sendAndWait({ prompt }, timeoutMs);
  } catch (error) {
    // The structured report is Convergent's completion contract. If the model
    // already submitted it but then failed to reach session.idle (for example
    // while producing unnecessary post-tool narration), preserve the report and
    // abort only the lingering turn. SDK sessions remain usable after abort().
    if (sink.value) {
      await session.abort?.().catch(() => {});
      return;
    }
    throw error;
  }
}

async function requireReport(session, sink, prompt, toolName, timeoutMs = 180_000) {
  sink.value = null;
  await sendAndCaptureReport(session, sink, prompt, timeoutMs);
  if (sink.value) return sink.value;

  await sendAndCaptureReport(
    session,
    sink,
    `You did not call ${toolName}. Do not perform more exploration. Complete the current pass now and call ${toolName} exactly once with your final structured result.`,
    timeoutMs,
  );
  if (!sink.value) {
    throw new Error(`Agent failed to call required tool ${toolName} after a retry.`);
  }
  return sink.value;
}

class ConvergentEngine {
  constructor({ client, sdk, workspace, models, permissionHandler, userInputHandler, ui, maxWorkerPasses = 8, maxReviewerCycles = 3, agentTurnTimeoutMs = 180_000, signal, revisionProvider = workspaceRevision }) {
    this.client = client;
    this.sdk = sdk;
    this.workspace = workspace;
    this.models = models;
    this.permissionHandler = permissionHandler;
    this.userInputHandler = userInputHandler;
    this.ui = ui;
    this.maxWorkerPasses = maxWorkerPasses;
    this.maxReviewerCycles = maxReviewerCycles;
    this.agentTurnTimeoutMs = agentTurnTimeoutMs;
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

    const beforePlan = await this.revisionProvider(this.workspace);
    const plan = await requireReport(
      coordinator.session,
      coordinator.sink,
      `User request:\n\n${userRequest}\n\nInspect only the repository context needed for this request, clarify only material ambiguities, then submit the smallest useful implementation plan with report_plan.`,
      'report_plan',
      this.agentTurnTimeoutMs,
    );
    const afterPlan = await this.revisionProvider(this.workspace);
    if (beforePlan !== afterPlan) {
      throw new Error('Coordinator changed the workspace despite the read-only contract.');
    }
    this.ui.plan(plan);

    for (let index = 0; index < plan.tasks.length; index += 1) {
      this.checkCancelled();
      const task = plan.tasks[index];
      this.ui.taskStarted(task, index + 1, plan.tasks.length);
      await this.runTask(factory, task, `${index + 1}-${task.id}`);
      this.ui.taskCompleted(task);
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
      const initial = await this.runWorkerPass(workerA, task, 'IMPLEMENT', null, null);
      this.ui.passResult('A', initial.report, initial.changed, initial.revision);
      if (initial.report.verdict === 'blocked') {
        throw new Error(`Worker A is blocked: ${initial.report.summary}`);
      }

      await this.convergeWorkers(task, workerA, workerB, workerB, initial);

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
            reviewCycle > 1
              ? 'Re-check your earlier findings against the current revision first. Then inspect only enough additional context to detect regressions or remaining task-level defects.'
              : 'Perform the strong review of this task. Inspect only context relevant to correctness and the acceptance criteria.',
            'Do not edit files. Call report_review exactly once as soon as you have the verdict.',
          ].join('\n'),
          'report_review',
          this.agentTurnTimeoutMs,
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
        const remediation = await this.runWorkerPass(workerA, task, 'FIX_STRONG_REVIEW_FINDINGS', review.findings, null);
        this.ui.passResult('A', remediation.report, remediation.changed, remediation.revision);
        if (remediation.report.verdict === 'blocked') {
          throw new Error(`Worker A is blocked during strong-review remediation: ${remediation.report.summary}`);
        }
        await this.convergeWorkers(task, workerA, workerB, workerB, remediation);
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
    let peerPass = previousPass;

    for (let pass = 1; pass <= this.maxWorkerPasses; pass += 1) {
      this.checkCancelled();
      const result = await this.runWorkerPass(worker, task, 'REVIEW_AND_FIX', null, peerPass);
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

      peerPass = result;
      worker = worker === workerA ? workerB : workerA;
    }

    throw new Error(`Workers did not converge within ${this.maxWorkerPasses} review/fix passes.`);
  }

  async runWorkerPass(worker, task, mode, findings, peerPass = null) {
    const before = await this.revisionProvider(this.workspace);
    const peerContext = peerPass ? formatPeerPass(peerPass) : '';
    const prompt = [
      `MODE: ${mode}`,
      taskPrompt(task),
      '',
      `Current workspace revision fingerprint: ${before}`,
      findings?.length ? `\nStrong reviewer findings to verify and address:\n${formatFindings(findings)}` : '',
      peerContext ? `\n${peerContext}` : '',
      '',
      mode === 'IMPLEMENT'
        ? 'Implement this task completely. Inspect only the repository context needed for the change and follow existing patterns.'
        : 'Review the CURRENT repository state independently. Fix every valid actionable issue you find; do not merely comment on it. Use your retained task context plus the peer report above, and avoid redundant exploration of unchanged context.',
      'Run only relevant checks, then call report_pass exactly once as soon as the pass is complete.',
    ].join('\n');

    const report = await requireReport(
      worker.session,
      worker.sink,
      prompt,
      'report_pass',
      this.agentTurnTimeoutMs,
    );
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

module.exports = {
  ConvergentEngine,
  taskPrompt,
  requireReport,
  formatFindings,
  formatPeerPass,
  sendAndCaptureReport,
};
