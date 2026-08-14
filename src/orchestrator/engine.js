'use strict';

const { workspaceRevision, assertGitRepository } = require('./revision');
const { normalizeTaskRoute, routePolicy, usesPeerConvergence } = require('./routing');
const { UsageTracker } = require('./usage');
const { SessionFactory } = require('../copilot/session-factory');
const { OperatorCredentialGuard, reconcileCredentialIntegrityReport } = require('../copilot/operator-credential-guard');
const { reconcileUnsupportedBlockedReport } = require('./report-integrity');
const {
  reconcileExplicitValidationBlocker,
  reconcileSupersededValidationBlocker,
} = require('./report-blocker');
const {
  captureWorkspaceChangeState,
  buildTaskChangeManifest,
  formatTaskChangeManifest,
} = require('./task-change-manifest');

const MUTATING_WORKER_TOOLS = new Set(['edit', 'apply_patch', 'create']);
const MAX_INSPECTION_HINTS = 12;

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

function formatInspectionHints(task) {
  const hints = Array.isArray(task?.inspectionHints)
    ? task.inspectionHints.map((hint) => String(hint ?? '').trim()).filter(Boolean).slice(0, MAX_INSPECTION_HINTS)
    : [];
  if (!hints.length) return '';
  return [
    'Coordinator inspection hints already identified during planning (bounded, non-authoritative):',
    ...hints.map((hint) => `- ${hint}`),
    'Use these as a starting point instead of rediscovering the same surfaces merely for reassurance. Verify them against the current repository state when relevant, and expand only when a concrete implementation need requires it.',
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
    ? `\nPeer checks on this revision:\n${peerPass.report.checks.map((check) => `- ${check}`).join('\n')}`
    : '';
  const manifest = peerPass.changeManifest
    ? `\n${formatTaskChangeManifest(peerPass.changeManifest, 'Deterministic task change manifest after the peer pass')}`
    : '';

  return [
    `Previous peer pass from Worker ${peerPass.worker}:`,
    `- verdict: ${peerPass.report.verdict}`,
    `- workspace changed: ${peerPass.changed ? 'yes' : 'no'}`,
    `- resulting revision: ${peerPass.revision}`,
    `- summary: ${peerPass.report.summary ?? ''}`,
    findings,
    checks,
    manifest,
    '',
    'Treat this as the peer worker\'s explicit technical position. Challenge it where warranted rather than simply agreeing with it. Verify claims against the current repository state, but do not repeat inspection that your retained context already makes unnecessary.',
  ].filter(Boolean).join('\n');
}

function evidenceFromPass(pass) {
  if (!pass?.report || !Array.isArray(pass.report.checks)) return [];
  return pass.report.checks
    .map((check) => String(check ?? '').trim())
    .filter(Boolean)
    .map((check) => ({ agent: `Worker ${pass.worker}`, check }));
}

function mergeEvidence(existing, pass, revision) {
  const base = pass?.revision === revision ? [...(existing ?? [])] : [];
  if (pass?.revision !== revision) return base;
  const seen = new Set(base.map((item) => `${item.agent}\0${item.check}`));
  for (const item of evidenceFromPass(pass)) {
    const key = `${item.agent}\0${item.check}`;
    if (!seen.has(key)) {
      seen.add(key);
      base.push(item);
    }
  }
  return base;
}

function formatValidationEvidence(evidence) {
  if (!evidence?.length) return 'No prior worker validation evidence was reported for this exact revision.';
  return [
    'Validation evidence already reported by workers for this exact revision:',
    ...evidence.map((item) => `- ${item.agent}: ${item.check}`),
    'Treat this as evidence, not proof. Rerun a check only when independent verification is justified by a concrete concern or task risk.',
  ].join('\n');
}

function passApprovesRevision(pass) {
  return pass?.report?.verdict === 'clean' || pass?.report?.verdict === 'changed';
}

function guardSnapshot(session) {
  try {
    return session?.__convergentGuard?.snapshot?.() ?? null;
  } catch {
    return null;
  }
}

function successfulMutatingToolCalls(snapshot) {
  let total = 0;
  for (const tool of snapshot?.tools ?? []) {
    const name = String(tool.name ?? '').split(':').pop();
    if (!MUTATING_WORKER_TOOLS.has(name)) continue;
    total += Math.max(0, Number(tool.calls ?? 0) - Number(tool.failures ?? 0));
  }
  return total;
}

function mutatingToolDelta(beforeSnapshot, afterSnapshot) {
  return Math.max(0, successfulMutatingToolCalls(afterSnapshot) - successfulMutatingToolCalls(beforeSnapshot));
}

function reconcileDeterministicIntegrity(report, {
  changed = false,
  role = 'Agent',
  credentialViolations = [],
  validationEvidence = [],
} = {}) {
  let current = report;
  const corrections = [];

  let result = reconcileCredentialIntegrityReport(current, credentialViolations, role);
  current = result.report;
  if (result.correction) corrections.push(result.correction);

  result = reconcileExplicitValidationBlocker(current);
  current = result.report;
  if (result.correction) corrections.push(result.correction);

  result = reconcileSupersededValidationBlocker(current, validationEvidence, { changed, role });
  current = result.report;
  if (result.correction) corrections.push(result.correction);

  const consistency = reconcileUnsupportedBlockedReport(current, { changed, role });
  current = consistency.report;
  if (consistency.correction) corrections.push(consistency.correction);
  return {
    report: current,
    correction: corrections.length ? corrections.join(' ') : null,
    corrections,
  };
}

function reconcileWorkerReport(report, changed, workerName, beforeSnapshot, afterSnapshot) {
  if (report.verdict === 'clean' && report.findings?.length) {
    throw new Error(`Worker ${workerName} reported CLEAN with actionable findings.`);
  }

  if (report.verdict === 'clean' && changed) {
    const writes = mutatingToolDelta(beforeSnapshot, afterSnapshot);
    if (writes <= 0) {
      throw new Error(`Worker ${workerName} reported CLEAN but the workspace changed without attributable worker edit/create/apply_patch activity.`);
    }
    return {
      report: { ...report, verdict: 'changed' },
      correction: `CLEAN -> CHANGED: workspace fingerprint changed and ${writes} successful worker write tool call(s) occurred during this pass.`,
    };
  }

  if (report.verdict === 'changed' && !changed) {
    return {
      report: { ...report, verdict: 'clean' },
      correction: 'CHANGED -> CLEAN: final workspace fingerprint is identical to the pass-start fingerprint.',
    };
  }

  return { report, correction: null };
}

async function sendAndCaptureReport(session, sink, prompt, timeoutMs) {
  try {
    // A successful report_* tool call is authoritative structured data, but it is
    // not a documented terminal signal for the Copilot agent loop. We therefore
    // still wait for the guarded session.idle boundary instead of aborting a
    // persistent session merely to suppress the model's post-tool continuation.
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
    `You did not call ${toolName} with an accepted result. Do not perform more exploration. Complete the current pass now and call ${toolName} exactly once with a semantically valid final structured result.`,
    timeoutMs,
  );
  if (!sink.value) throw new Error(`Agent failed to call required tool ${toolName} with an accepted result after a retry.`);
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
    operatorCredentialGuard = null,
    signal,
    revisionProvider = workspaceRevision,
    changeStateProvider = captureWorkspaceChangeState,
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
    this.operatorCredentialGuard = operatorCredentialGuard ?? new OperatorCredentialGuard();
    this.signal = signal;
    this.revisionProvider = revisionProvider;
    this.changeStateProvider = changeStateProvider;
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

  async createTaskContext(factory) {
    try {
      return {
        flowMode: factory?.flowMode ?? 'auto',
        baselineChangeState: await this.changeStateProvider(this.workspace),
      };
    } catch (error) {
      this.ui?.log?.(`Task change manifest baseline unavailable: ${error?.message ?? String(error)}`);
      return { flowMode: factory?.flowMode ?? 'auto', baselineChangeState: null };
    }
  }

  async currentTaskChangeManifest(taskContext) {
    if (!taskContext?.baselineChangeState) return null;
    try {
      const currentState = await this.changeStateProvider(
        this.workspace,
        taskContext.baselineChangeState.head ?? null,
      );
      return buildTaskChangeManifest(taskContext.baselineChangeState, currentState);
    } catch (error) {
      this.ui?.log?.(`Task change manifest refresh unavailable: ${error?.message ?? String(error)}`);
      return null;
    }
  }

  sessionFactory() {
    return new SessionFactory({
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
      operatorCredentialGuard: this.operatorCredentialGuard,
    });
  }

  async run(userRequest) {
    await assertGitRepository(this.workspace);
    this.checkCancelled();

    const factory = this.sessionFactory();

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
      [
        `User request:\n\n${userRequest}`,
        '',
        'Inspect only what is needed, clarify material ambiguity, classify every task, and submit the smallest proportionate plan with report_plan. For read_only tasks, perform the inspection now and include the answer in task.result.',
        `For each modifying task, if planning already identified concrete relevant repository-relative files, paths, symbols, or tests, include up to ${MAX_INSPECTION_HINTS} concise inspectionHints. These are non-authoritative Worker A starting hints, not a transcript: do not copy tool output/context and do not perform extra inspection merely to populate them.`,
      ].join('\n'),
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
      const policy = routePolicy(routing.route, routing.risk, routing.peerConvergence, routing.architecture);
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
    return this.runFullTask(factory, task, taskSessionKey, routing);
  }

  async runTrivialTask(factory, task, taskSessionKey, routing = { risk: 'low' }) {
    let workerA;
    let workerB;
    let reviewer;
    try {
      workerA = await factory.createWorker(taskSessionKey, 'A', 'trivial', routing.risk);
      workerB = await factory.createWorker(taskSessionKey, 'B', 'trivial', routing.risk);
      const taskContext = await this.createTaskContext(factory);
      this.sessions.push(workerA.session, workerB.session);
      this.ui.agentConfiguration([
        { role: 'A', model: workerA.model.name ?? workerA.model.id, effort: workerA.reasoningEffort },
        { role: 'B', model: workerB.model.name ?? workerB.model.id, effort: workerB.reasoningEffort },
      ]);

      const initial = await this.runWorkerPass(workerA, task, 'IMPLEMENT', null, null, taskContext);
      this.ui.passResult('A', initial.report, initial.changed, initial.revision, initial);
      if (initial.report.verdict === 'blocked') throw new Error(`Worker A is blocked: ${initial.report.summary}`);

      const peer = await this.runWorkerPass(workerB, task, 'REVIEW_AND_FIX', null, initial, taskContext);
      this.ui.passResult('B', peer.report, peer.changed, peer.revision, peer);
      if (peer.report.verdict === 'blocked') throw new Error(`Worker B is blocked: ${peer.report.summary}`);

      if (!peer.changed && peer.report.verdict === 'clean') {
        return { route: 'trivial', escalated: false };
      }

      this.ui.escalated('trivial', 'standard', 'The peer reviewer changed the workspace, so the lightweight approval is no longer sufficient.');
      reviewer = await factory.createReviewer(taskSessionKey, 'standard', routing.risk);
      this.sessions.push(reviewer.session);
      this.ui.agentConfiguration([
        { role: 'Strong reviewer', model: reviewer.model.name ?? reviewer.model.id, effort: reviewer.reasoningEffort },
      ]);

      const convergence = await this.convergeWorkers(task, workerA, workerB, workerA, peer, taskContext);
      await this.runStrongReview(task, workerA, workerB, reviewer, convergence.evidence, {
        route: 'standard',
        risk: routing.risk,
      }, taskContext);
      return { route: 'standard', escalated: true };
    } finally {
      await this.disposeTaskSessions([workerA?.session, workerB?.session, reviewer?.session]);
    }
  }

  async runFullTask(factory, task, taskSessionKey, routing) {
    let workerA;
    let workerB;
    let reviewer;
    const route = routing.route;
    const peerConvergence = usesPeerConvergence(routing);
    try {
      workerA = await factory.createWorker(taskSessionKey, 'A', route, routing.risk);
      if (peerConvergence) workerB = await factory.createWorker(taskSessionKey, 'B', route, routing.risk);
      reviewer = await factory.createReviewer(taskSessionKey, route, routing.risk);
      const taskContext = await this.createTaskContext(factory);
      this.sessions.push(...[workerA?.session, workerB?.session, reviewer?.session].filter(Boolean));
      this.ui.agentConfiguration([
        { role: 'A', model: workerA.model.name ?? workerA.model.id, effort: workerA.reasoningEffort },
        ...(workerB ? [{ role: 'B', model: workerB.model.name ?? workerB.model.id, effort: workerB.reasoningEffort }] : []),
        { role: 'Strong reviewer', model: reviewer.model.name ?? reviewer.model.id, effort: reviewer.reasoningEffort },
      ]);

      const initial = await this.runWorkerPass(workerA, task, 'IMPLEMENT', null, null, taskContext);
      this.ui.passResult('A', initial.report, initial.changed, initial.revision, initial);
      if (initial.report.verdict === 'blocked') throw new Error(`Worker A is blocked: ${initial.report.summary}`);

      let evidence = evidenceFromPass(initial);
      if (peerConvergence) {
        const convergence = await this.convergeWorkers(task, workerA, workerB, workerB, initial, taskContext);
        evidence = convergence.evidence;
      }
      await this.runStrongReview(task, workerA, workerB, reviewer, evidence, routing, taskContext);
      return { route, escalated: false };
    } finally {
      await this.disposeTaskSessions([workerA?.session, workerB?.session, reviewer?.session]);
    }
  }

  async runStrongReview(
    task,
    workerA,
    workerB,
    reviewer,
    initialEvidence = [],
    routing = { route: 'standard', risk: 'medium' },
    taskContext = null,
  ) {
    let evidence = [...initialEvidence];
    const peerConvergence = usesPeerConvergence(routing);
    for (let reviewCycle = 1; reviewCycle <= this.maxReviewerCycles; reviewCycle += 1) {
      this.checkCancelled();
      const beforeReview = await this.revisionProvider(this.workspace);
      const changeManifest = await this.currentTaskChangeManifest(taskContext);
      const startedAt = Date.now();
      let review = await requireReport(
        reviewer.session,
        reviewer.sink,
        [
          taskPrompt(task),
          '',
          peerConvergence
            ? `Worker A and Worker B approved current revision ${beforeReview.slice(0, 12)}.`
            : `Worker A produced current revision ${beforeReview.slice(0, 12)}; you are the independent acceptance gate for this standard task.`,
          `Task workflow: ${routing.route}; task risk: ${routing.risk}.`,
          formatValidationEvidence(evidence),
          changeManifest ? `\n${formatTaskChangeManifest(changeManifest, 'Deterministic task change manifest for this review')}` : '',
          '',
          reviewCycle > 1
            ? 'Re-check your earlier findings against the current revision first. Then inspect only enough additional context to detect regressions or remaining task-level defects.'
            : 'Perform the strong review of this task. Inspect only context relevant to correctness and the acceptance criteria.',
          'Start with the exact task-change paths above when available instead of guessing or rediscovering file locations. Do not edit files. Call report_review exactly once as soon as you have the verdict.',
        ].filter(Boolean).join('\n'),
        'report_review',
        this.agentTurnTimeoutMs,
      );
      const reviewIntegrity = reconcileDeterministicIntegrity(review, {
        changed: false,
        role: 'Strong reviewer',
        credentialViolations: this.operatorCredentialGuard?.consumeViolations('Strong reviewer') ?? [],
        validationEvidence: evidence,
      });
      review = reviewIntegrity.report;
      if (reviewIntegrity.correction) {
        this.ui?.log?.(`Strong reviewer verdict reconciled by Convergent: ${reviewIntegrity.correction}`);
      }
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

      this.ui.phase(
        'Remediation',
        peerConvergence
          ? `Strong reviewer returned ${review.findings.length} finding(s); Worker A remediates, then A/B convergence repeats.`
          : `Strong reviewer returned ${review.findings.length} finding(s); Worker A remediates, then the same strong reviewer performs a delta re-check.`,
      );
      const remediation = await this.runWorkerPass(workerA, task, 'FIX_STRONG_REVIEW_FINDINGS', review.findings, null, taskContext);
      this.ui.passResult('A', remediation.report, remediation.changed, remediation.revision, remediation);
      if (remediation.report.verdict === 'blocked') {
        throw new Error(`Worker A is blocked during strong-review remediation: ${remediation.report.summary}`);
      }
      if (peerConvergence) {
        const convergence = await this.convergeWorkers(task, workerA, workerB, workerB, remediation, taskContext);
        evidence = convergence.evidence;
      } else {
        evidence = evidenceFromPass(remediation);
      }
    }
  }

  async convergeWorkers(task, workerA, workerB, nextWorker, previousPass, taskContext = null) {
    const approvals = new Map();
    if (passApprovesRevision(previousPass)) approvals.set(previousPass.worker, previousPass.revision);

    let currentRevision = previousPass.revision;
    let evidence = evidenceFromPass(previousPass);
    let worker = nextWorker;
    let peerPass = previousPass;

    for (let pass = 1; pass <= this.maxWorkerPasses; pass += 1) {
      this.checkCancelled();
      const result = await this.runWorkerPass(worker, task, 'REVIEW_AND_FIX', null, peerPass, taskContext);
      this.ui.passResult(worker.name, result.report, result.changed, result.revision, result);

      if (result.report.verdict === 'blocked') throw new Error(`Worker ${worker.name} is blocked: ${result.report.summary}`);

      if (result.changed) {
        approvals.clear();
        currentRevision = result.revision;
        evidence = evidenceFromPass(result);
      } else {
        evidence = mergeEvidence(evidence, result, currentRevision);
      }

      if (passApprovesRevision(result)) approvals.set(worker.name, result.revision);

      if (approvals.get('A') === currentRevision && approvals.get('B') === currentRevision) {
        this.ui.converged(currentRevision, pass);
        return { revision: currentRevision, evidence };
      }

      peerPass = result;
      worker = worker === workerA ? workerB : workerA;
    }

    throw new Error(`Workers did not converge within ${this.maxWorkerPasses} review/fix passes.`);
  }

  async runWorkerPass(worker, task, mode, findings, peerPass = null, taskContext = null) {
    const before = await this.revisionProvider(this.workspace);
    const beforeGuard = guardSnapshot(worker.session);
    const peerContext = peerPass ? formatPeerPass(peerPass) : '';
    const inspectionHints = mode === 'IMPLEMENT' ? formatInspectionHints(task) : '';
    const fastBRequirement = worker.name === 'B' && taskContext?.flowMode === 'fast'
      ? 'FAST Worker B requirement: when the peer handoff includes a deterministic task change manifest, inspect the actual diff/current implementation for those exact paths before deciding CLEAN. Symbol search/grep plus rerunning tests alone is not an adversarial review. Use tests only when they answer a concrete correctness question.'
      : '';
    const prompt = [
      `MODE: ${mode}`,
      taskPrompt(task),
      '',
      `Current workspace revision fingerprint: ${before}`,
      inspectionHints ? `\n${inspectionHints}` : '',
      findings?.length ? `\nStrong reviewer findings to verify and address:\n${formatFindings(findings)}` : '',
      peerContext ? `\n${peerContext}` : '',
      fastBRequirement ? `\n${fastBRequirement}` : '',
      '',
      mode === 'IMPLEMENT'
        ? 'Implement this task completely. Inspect only the repository context needed for the change and follow existing patterns.'
        : 'Review the CURRENT repository state independently. Fix every valid actionable issue you find; do not merely comment on it. Use your retained task context plus the peer report above, including any validation evidence reported for the current revision, and avoid redundant exploration or check reruns without a concrete reason.',
      'Run only relevant checks that are still needed and avoid leaving validation artifacts.',
      'Verdict semantics are based on the FINAL workspace fingerprint: if a successful edit/apply_patch/create leaves the final fingerprint different from the one above, report CHANGED; report CLEAN only when the final fingerprint is identical. Then call report_pass exactly once as soon as the pass is complete.',
    ].filter(Boolean).join('\n');

    const startedAt = Date.now();
    const submittedReport = await requireReport(worker.session, worker.sink, prompt, 'report_pass', this.agentTurnTimeoutMs);
    const after = await this.revisionProvider(this.workspace);
    const afterGuard = guardSnapshot(worker.session);
    const usage = await this.finishTurn(worker, startedAt);
    const durationMs = Date.now() - startedAt;
    const changed = before !== after;
    const workspaceReconciled = reconcileWorkerReport(submittedReport, changed, worker.name, beforeGuard, afterGuard);
    const integrityReconciled = reconcileDeterministicIntegrity(workspaceReconciled.report, {
      changed,
      role: `Worker ${worker.name}`,
      credentialViolations: this.operatorCredentialGuard?.consumeViolations(`Worker ${worker.name}`) ?? [],
      validationEvidence: peerPass?.revision === after ? evidenceFromPass(peerPass) : [],
    });
    const corrections = [workspaceReconciled.correction, integrityReconciled.correction].filter(Boolean);
    const correction = corrections.length ? corrections.join(' ') : null;
    const changeManifest = await this.currentTaskChangeManifest(taskContext);

    if (correction) {
      this.ui?.log?.(`Worker ${worker.name} verdict reconciled by Convergent: ${correction}`);
    }

    return {
      worker: worker.name,
      report: integrityReconciled.report,
      changed,
      revision: after,
      durationMs,
      usage,
      verdictCorrection: correction,
      changeManifest,
    };
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
  formatInspectionHints,
  requireReport,
  formatFindings,
  formatPeerPass,
  evidenceFromPass,
  mergeEvidence,
  formatValidationEvidence,
  passApprovesRevision,
  guardSnapshot,
  successfulMutatingToolCalls,
  mutatingToolDelta,
  reconcileWorkerReport,
  reconcileDeterministicIntegrity,
  sendAndCaptureReport,
  MAX_INSPECTION_HINTS,
};
