'use strict';

const { workspaceRevision, assertGitRepository } = require('./revision');
const { normalizeTaskRoute, routePolicy } = require('./routing');
const { UsageTracker } = require('./usage');
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
  if (!sink.value) throw new Error(`Agent failed to call required tool ${toolName} after a retry.`);
  return sink.value;
}

class ConvergentEngine {
  constructor({
    client,
    sdk,
    workspace,
    models,
    permissionHandler,
    userInputHandler,
    ui,
    maxWorkerPasses = 8,
    maxReviewerCycles = 3,
    agentTurnTimeoutMs = 180_000,
    routingMode = 'adaptive',
    reasoningMode = 'adaptive',
    signal,
    revisionProvider = workspaceRevision,
  }) {
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
    this.routingMode = routingMode;
    this.reasoningMode = reasoningMode;
    this.signal = signal;
    this.revisionProvider = revisionProvider;
    this.runId = `convergent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sessions = [];
    this.usage = new UsageTracker();
    this.stats = { tasks: 0, trivial: 0, full: 0, readOnly: 0, escalations: 0 };
  }

  checkCancelled() {
    if (this.signal?.aborted) throw new Error('Convergent workflow cancelled by user.');
  }

  getUsageSummary() {
    return this.usage.summary();
  }

  async finishTurn(agent, startedAt) {
    if (!agent?.usageName) return this.getUsageSummary();
    this.usage.recordTurn(agent.usageName, Date.now() - startedAt);
    await this.usage.refresh(agent.usageName, agent.session);
    return this.getUsageSummary();
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
      usage: this.usage,
      runId: this.runId,
      reasoningMode: this.reasoningMode,
    });

    this.ui.phase('Planning', 'Coordinator is inspecting the repository, classifying risk, and choosing the proportionate workflow.');
    const coordinator = await factory.createCoordinator();
    this.sessions.push(coordinator.session);
    this.ui.agentConfiguration([
      { role: 'Coordinator', model: coordinator.model.name ?? coordinator.model.id, effort: coordinator.reasoningEffort },
    ]);

    const beforePlan = await this.revisionProvider(this.workspace);
    const planStartedAt = Date.now();
    const plan = await requireReport(
      coordinator.session,
      coordinator.sink,
      `User request:\n\n${userRequest}\n\nInspect only what is needed, clarify material ambiguity, classify every task, and submit the smallest proportionate plan with report_plan. For read_only tasks, perform the inspection now and include the answer in task.result.`,
      'report_plan',
      this.agentTurnTimeoutMs,
    );
    const afterPlan = await this.revisionProvider(this.workspace);
    const planningUsage = await this.finishTurn(coordinator, planStartedAt);
    if (beforePlan !== afterPlan) throw new Error('Coordinator changed the workspace despite the read-only contract.');

    const routings = plan.tasks.map((task) => normalizeTaskRoute(task, this.routingMode));
    for (let index = 0; index < plan.tasks.length; index += 1) {
      if (routings[index].route === 'read_only' && !plan.tasks[index].result) {
        throw new Error(`Coordinator classified task ${plan.tasks[index].id} as read_only but did not provide task.result.`);
      }
    }
    this.ui.plan(plan, routings);
    this.ui.usageProgress(planningUsage);

    this.stats.tasks = plan.tasks.length;
    for (let index = 0; index < plan.tasks.length; index += 1) {
      this.checkCancelled();
      const task = plan.tasks[index];
      const routing = routings[index];
      const policy = routePolicy(routing.route);
      this.ui.taskStarted(task, index + 1, plan.tasks.length, routing, policy);

      if (routing.route === 'read_only') {
        this.stats.readOnly += 1;
        this.ui.readOnlyResult(task);
        this.ui.taskCompleted(task, 'read_only');
        continue;
      }

      const outcome = await this.runTask(factory, task, `${index + 1}-${task.id}`, routing);
      if (outcome.route === 'trivial') this.stats.trivial += 1;
      else this.stats.full += 1;
      if (outcome.escalated) this.stats.escalations += 1;
      this.ui.taskCompleted(task, outcome.route);
    }

    await this.usage.refresh(coordinator.usageName, coordinator.session);
    const finalUsage = this.getUsageSummary();
    this.ui.phase('Complete', `All ${plan.tasks.length} task(s) completed under their enforced workflow routes.`);
    this.ui.runSummary(finalUsage, this.stats);
    return { plan, usage: finalUsage, stats: { ...this.stats } };
  }

  async runTask(factory, task, taskSessionKey, routing) {
    if (routing.route === 'trivial') return this.runTrivialTask(factory, task, taskSessionKey, routing);
    return this.runFullTask(factory, task, taskSessionKey, routing.route);
  }

  async runTrivialTask(factory, task, taskSessionKey) {
    let workerA;
    let workerB;
    let reviewer;
    try {
      workerA = await factory.createWorker(taskSessionKey, 'A', 'trivial');
      workerB = await factory.createWorker(taskSessionKey, 'B', 'trivial');
      this.sessions.push(workerA.session, workerB.session);
      this.ui.agentConfiguration([
        { role: 'A', model: workerA.model.name ?? workerA.model.id, effort: workerA.reasoningEffort },
        { role: 'B', model: workerB.model.name ?? workerB.model.id, effort: workerB.reasoningEffort },
      ]);

      const initial = await this.runWorkerPass(workerA, task, 'IMPLEMENT', null, null);
      this.ui.passResult('A', initial.report, initial.changed, initial.revision, initial);
      if (initial.report.verdict === 'blocked') throw new Error(`Worker A is blocked: ${initial.report.summary}`);

      const peer = await this.runWorkerPass(workerB, task, 'REVIEW_AND_FIX', null, initial);
      this.ui.passResult('B', peer.report, peer.changed, peer.revision, peer);
      if (peer.report.verdict === 'blocked') throw new Error(`Worker B is blocked: ${peer.report.summary}`);

      if (!peer.changed && peer.report.verdict === 'clean') {
        return { route: 'trivial', escalated: false };
      }

      this.ui.escalated('trivial', 'standard', 'The peer reviewer changed the workspace, so the lightweight approval is no longer sufficient.');
      reviewer = await factory.createReviewer(taskSessionKey, 'standard');
      this.sessions.push(reviewer.session);
      this.ui.agentConfiguration([
        { role: 'Strong reviewer', model: reviewer.model.name ?? reviewer.model.id, effort: reviewer.reasoningEffort },
      ]);

      await this.convergeWorkers(task, workerA, workerB, workerA, peer);
      await this.runStrongReview(task, workerA, workerB, reviewer);
      return { route: 'standard', escalated: true };
    } finally {
      await this.disposeTaskSessions([workerA?.session, workerB?.session, reviewer?.session]);
    }
  }

  async runFullTask(factory, task, taskSessionKey, route) {
    let workerA;
    let workerB;
    let reviewer;
    try {
      workerA = await factory.createWorker(taskSessionKey, 'A', route);
      workerB = await factory.createWorker(taskSessionKey, 'B', route);
      reviewer = await factory.createReviewer(taskSessionKey, route);
      this.sessions.push(workerA.session, workerB.session, reviewer.session);
      this.ui.agentConfiguration([
        { role: 'A', model: workerA.model.name ?? workerA.model.id, effort: workerA.reasoningEffort },
        { role: 'B', model: workerB.model.name ?? workerB.model.id, effort: workerB.reasoningEffort },
        { role: 'Strong reviewer', model: reviewer.model.name ?? reviewer.model.id, effort: reviewer.reasoningEffort },
      ]);

      const initial = await this.runWorkerPass(workerA, task, 'IMPLEMENT', null, null);
      this.ui.passResult('A', initial.report, initial.changed, initial.revision, initial);
      if (initial.report.verdict === 'blocked') throw new Error(`Worker A is blocked: ${initial.report.summary}`);

      await this.convergeWorkers(task, workerA, workerB, workerB, initial);
      await this.runStrongReview(task, workerA, workerB, reviewer);
      return { route, escalated: false };
    } finally {
      await this.disposeTaskSessions([workerA?.session, workerB?.session, reviewer?.session]);
    }
  }

  async runStrongReview(task, workerA, workerB, reviewer) {
    for (let reviewCycle = 1; reviewCycle <= this.maxReviewerCycles; reviewCycle += 1) {
      this.checkCancelled();
      const beforeReview = await this.revisionProvider(this.workspace);
      const startedAt = Date.now();
      const review = await requireReport(
        reviewer.session,
        reviewer.sink,
        [
          taskPrompt(task),
          '',
          `Worker A and Worker B approved current revision ${beforeReview.slice(0, 12)}.`,
          reviewCycle > 1
            ? 'Re-check your earlier findings against the current revision first. Then inspect only enough additional context to detect regressions or remaining task-level defects.'
            : 'Perform the strong review of this task. Inspect only context relevant to correctness and the acceptance criteria.',
          'Do not edit files. Call report_review exactly once as soon as you have the verdict.',
        ].join('\n'),
        'report_review',
        this.agentTurnTimeoutMs,
      );
      const afterReview = await this.revisionProvider(this.workspace);
      const usage = await this.finishTurn(reviewer, startedAt);
      const durationMs = Date.now() - startedAt;
      if (beforeReview !== afterReview) throw new Error('Strong reviewer changed the workspace despite the read-only contract.');
      this.ui.reviewResult(review, reviewCycle, { durationMs, usage });

      if (review.verdict === 'clean') return;
      if (review.verdict === 'blocked') throw new Error(`Strong reviewer is blocked: ${review.summary}`);
      if (!review.findings?.length) throw new Error('Strong reviewer returned findings without any actionable findings.');
      if (reviewCycle === this.maxReviewerCycles) {
        throw new Error(`Strong review still has findings after ${this.maxReviewerCycles} remediation cycles.`);
      }

      this.ui.phase('Remediation', `Strong reviewer returned ${review.findings.length} finding(s); Worker A remediates, then A/B convergence repeats.`);
      const remediation = await this.runWorkerPass(workerA, task, 'FIX_STRONG_REVIEW_FINDINGS', review.findings, null);
      this.ui.passResult('A', remediation.report, remediation.changed, remediation.revision, remediation);
      if (remediation.report.verdict === 'blocked') {
        throw new Error(`Worker A is blocked during strong-review remediation: ${remediation.report.summary}`);
      }
      await this.convergeWorkers(task, workerA, workerB, workerB, remediation);
    }
  }

  async convergeWorkers(task, workerA, workerB, nextWorker, previousPass) {
    const approvals = new Map();
    if (!previousPass.changed && previousPass.report.verdict === 'clean') approvals.set(previousPass.worker, previousPass.revision);

    let currentRevision = previousPass.revision;
    let worker = nextWorker;
    let peerPass = previousPass;

    for (let pass = 1; pass <= this.maxWorkerPasses; pass += 1) {
      this.checkCancelled();
      const result = await this.runWorkerPass(worker, task, 'REVIEW_AND_FIX', null, peerPass);
      this.ui.passResult(worker.name, result.report, result.changed, result.revision, result);

      if (result.report.verdict === 'blocked') throw new Error(`Worker ${worker.name} is blocked: ${result.report.summary}`);

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

    const startedAt = Date.now();
    const report = await requireReport(worker.session, worker.sink, prompt, 'report_pass', this.agentTurnTimeoutMs);
    const after = await this.revisionProvider(this.workspace);
    const usage = await this.finishTurn(worker, startedAt);
    const durationMs = Date.now() - startedAt;
    const changed = before !== after;

    if (report.verdict === 'clean' && changed) throw new Error(`Worker ${worker.name} reported CLEAN but changed the workspace.`);
    if (report.verdict === 'changed' && !changed) throw new Error(`Worker ${worker.name} reported CHANGED but the workspace revision is identical.`);
    if (report.verdict === 'clean' && report.findings?.length) throw new Error(`Worker ${worker.name} reported CLEAN with actionable findings.`);

    return { worker: worker.name, report, changed, revision: after, durationMs, usage };
  }

  async disposeTaskSessions(taskSessions) {
    const sessions = taskSessions.filter(Boolean);
    await Promise.allSettled(sessions.map((session) => session.disconnect()));
    this.sessions = this.sessions.filter((session) => !sessions.includes(session));
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
