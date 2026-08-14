'use strict';

const {
  ConvergentEngine,
  requireReport,
  taskPrompt,
  formatValidationEvidence,
  passApprovesRevision,
  evidenceFromPass,
  mergeEvidence,
} = require('./engine');
const { assertGitRepository } = require('./revision');
const { normalizeTaskRoute, routePolicy } = require('./routing');
const { RESUME_STATE_VERSION, defaultStats } = require('./resume');
const { pauseWorkflow } = require('./control');
const { isWorkingTreeClean, createTaskCommit } = require('./task-commit');

function checkpointPass(pass) {
  if (!pass) return null;
  return {
    worker: pass.worker,
    report: pass.report,
    changed: Boolean(pass.changed),
    revision: pass.revision,
  };
}

class ResumableConvergentEngine extends ConvergentEngine {
  constructor(options) {
    super(options);
    this.onCheckpoint = typeof options.onCheckpoint === 'function' ? options.onCheckpoint : async () => {};
    this.activeTaskCheckpointContext = null;
    this.maxAiCredits = Math.max(0, Number(options.maxAiCredits) || 0);
    this.aiCreditIncrement = this.maxAiCredits;
    this.aiCreditCeiling = this.maxAiCredits > 0 ? this.maxAiCredits : Number.POSITIVE_INFINITY;
    this.taskCommitMode = options.taskCommitMode === 'safe' ? 'safe' : 'off';
  }

  async saveCheckpoint({
    request,
    plan = null,
    status,
    nextTaskIndex = 0,
    currentTaskIndex = null,
    stage,
    taskState = null,
  }) {
    let revision;
    try {
      revision = await this.revisionProvider(this.workspace);
    } catch {
      revision = undefined;
    }
    const state = {
      version: RESUME_STATE_VERSION,
      workspace: this.workspace,
      request,
      plan,
      status,
      nextTaskIndex,
      currentTaskIndex,
      stage,
      taskState,
      revision,
      stats: { ...this.stats },
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.onCheckpoint(state);
    } catch (error) {
      this.ui?.log?.(`Could not persist resume checkpoint: ${error.message ?? String(error)}`);
    }
    return state;
  }

  async saveTaskCheckpoint(taskState) {
    const context = this.activeTaskCheckpointContext;
    if (!context) return null;
    return this.saveCheckpoint({
      request: context.request,
      plan: context.plan,
      status: 'running',
      nextTaskIndex: context.index,
      currentTaskIndex: context.index,
      stage: taskState.stage,
      taskState,
    });
  }

  async requestLimitExtension(kind, current, limit) {
    const decision = await this.ui?.limitDecision?.(kind, { current, limit });
    if (decision?.action === 'continue') {
      return Math.max(1, Math.floor(Number(decision.additional) || 1));
    }
    pauseWorkflow(
      kind === 'worker_passes'
        ? `Paused after ${current} A/B review/fix passes without convergence. The current task checkpoint was kept.`
        : `Paused after strong-review cycle ${current} with unresolved findings checkpointed.`,
      { kind, current, limit },
    );
  }

  async checkAiCreditBudget(context) {
    if (!Number.isFinite(this.aiCreditCeiling)) return;
    const usage = this.getUsageSummary();
    if (!usage?.hasCreditData || usage.aiCredits < this.aiCreditCeiling) return;

    const decision = await this.ui?.limitDecision?.('ai_credits', {
      current: usage.aiCredits,
      limit: this.aiCreditCeiling,
      increment: this.aiCreditIncrement,
      context,
    });
    if (decision?.action === 'unlimited') {
      this.aiCreditCeiling = Number.POSITIVE_INFINITY;
      this.ui?.phase?.('Budget extended', 'AI-credit soft limit disabled for the remainder of this run.');
      return;
    }
    if (decision?.action === 'continue') {
      const additional = Math.max(1, Number(decision.additional) || this.aiCreditIncrement || 100);
      this.aiCreditCeiling = usage.aiCredits + additional;
      this.ui?.phase?.('Budget extended', `Continuing with another ${additional} AI-credit tranche; next decision at approximately ${this.aiCreditCeiling.toFixed(3)} reported credits.`);
      return;
    }

    pauseWorkflow(
      `Paused after reaching the configured AI-credit budget at a safe workflow boundary (${usage.aiCredits.toFixed(3)} reported credits).`,
      { kind: 'ai_credits', current: usage.aiCredits, limit: this.aiCreditCeiling, context },
    );
  }

  async requestWorkerBlockedDecision(task, blockedWorker, peerWorker, result, routing, { nextReviewCycle = 1 } = {}) {
    await this.saveTaskCheckpoint({
      stage: 'worker_blocked',
      worker: blockedWorker.name,
      blockedPass: checkpointPass(result),
      nextReviewCycle,
      routing,
    });

    this.ui?.phase?.(
      'Worker blocked',
      `Worker ${blockedWorker.name} could not fully complete or validate task ${task.id}. The current workspace revision is preserved${result.changed ? ' and contains worker changes' : ''}; choose how to continue instead of failing the workflow.`,
    );

    const peerChoice = `Let Worker ${peerWorker.name} inspect current revision`;
    const retryChoice = `Retry Worker ${blockedWorker.name} now`;
    const pauseChoice = 'Pause & resume later';
    const response = await this.userInputHandler?.({
      question: [
        `Worker ${blockedWorker.name} reported BLOCKED for task ${task.id}.`,
        result.report?.summary ?? 'No blocker summary was provided.',
        result.changed
          ? 'The worker changed the workspace before reporting the blocker. Those changes are preserved, but BLOCKED does not approve the revision.'
          : 'The worker did not change the workspace in this pass.',
        `Choose whether ${peerWorker.name} should independently inspect/try to resolve the current revision, whether ${blockedWorker.name} should retry now, or pause so the environment can be fixed before /resume.`,
      ].join('\n\n'),
      choices: [peerChoice, retryChoice, pauseChoice],
    });

    const answer = response?.answer;
    this.ui?.log?.(`Worker blocker decision for ${blockedWorker.name}: ${answer ?? 'dismissed'}; task=${task.id}; revision=${result.revision}`);
    if (answer === peerChoice) return { action: 'peer' };
    if (answer === retryChoice) return { action: 'retry' };

    pauseWorkflow(
      `Paused because Worker ${blockedWorker.name} is blocked on task ${task.id}. The blocker and current workspace revision were checkpointed.`,
      { kind: 'worker_blocked', task: task.id, worker: blockedWorker.name, summary: result.report?.summary },
    );
  }

  async requestReviewerBlockedDecision(task, review, reviewCycle, evidence, routing) {
    await this.saveTaskCheckpoint({
      stage: 'strong_review_blocked',
      reviewCycle,
      summary: review.summary,
      evidence,
      routing,
    });

    this.ui?.phase?.(
      'Strong reviewer blocked',
      `Strong reviewer could not complete cycle ${reviewCycle} for task ${task.id}. The converged revision is preserved; retry or pause instead of failing the workflow.`,
    );

    const retryChoice = 'Retry strong reviewer now';
    const pauseChoice = 'Pause & resume later';
    const response = await this.userInputHandler?.({
      question: `Strong reviewer reported BLOCKED for task ${task.id}:\n\n${review.summary}\n\nThe reviewer is a required gate, so Convergent will not silently bypass it. Retry now or pause and resume after the environment/blocker is addressed.`,
      choices: [retryChoice, pauseChoice],
    });
    const answer = response?.answer;
    this.ui?.log?.(`Strong reviewer blocker decision: ${answer ?? 'dismissed'}; task=${task.id}; cycle=${reviewCycle}`);
    if (answer === retryChoice) return { action: 'retry' };

    pauseWorkflow(
      `Paused because the strong reviewer is blocked on task ${task.id} at cycle ${reviewCycle}. The review boundary was checkpointed.`,
      { kind: 'strong_review_blocked', task: task.id, reviewCycle, summary: review.summary },
    );
  }

  async convergeFromPass(task, workerA, workerB, pass, routing, { nextReviewCycle = 1 } = {}) {
    let current = pass;
    const producer = current.worker === 'B' ? workerB : workerA;
    const peer = producer === workerA ? workerB : workerA;

    while (current.report?.verdict === 'blocked') {
      const decision = await this.requestWorkerBlockedDecision(
        task,
        producer,
        peer,
        current,
        routing,
        { nextReviewCycle },
      );
      if (decision.action === 'peer') break;

      this.ui?.phase?.('Retrying blocked worker', `Worker ${producer.name} will re-check the current workspace and blocker without discarding its existing changes.`);
      current = await this.runWorkerPass(producer, task, 'RETRY_AFTER_BLOCK', null, null);
      this.ui.passResult(producer.name, current.report, current.changed, current.revision, current);
    }

    return this.convergeWorkers(
      task,
      workerA,
      workerB,
      peer,
      current,
      { nextReviewCycle, routing },
    );
  }

  async convergeWorkers(task, workerA, workerB, nextWorker, previousPass, { nextReviewCycle = 1, routing = { route: 'standard', risk: 'medium' } } = {}) {
    const approvals = new Map();
    if (passApprovesRevision(previousPass)) approvals.set(previousPass.worker, previousPass.revision);

    let currentRevision = previousPass.revision;
    let evidence = evidenceFromPass(previousPass);
    let worker = nextWorker;
    let peerPass = previousPass;
    let pass = 1;
    let passCeiling = Math.max(1, Number(this.maxWorkerPasses) || 8);

    while (true) {
      this.checkCancelled();
      const result = await this.runWorkerPass(worker, task, 'REVIEW_AND_FIX', null, peerPass);
      this.ui.passResult(worker.name, result.report, result.changed, result.revision, result);

      if (result.changed) {
        approvals.clear();
        currentRevision = result.revision;
        evidence = evidenceFromPass(result);
      } else {
        evidence = mergeEvidence(evidence, result, currentRevision);
      }

      if (result.report.verdict === 'blocked') {
        const peer = worker === workerA ? workerB : workerA;
        const decision = await this.requestWorkerBlockedDecision(
          task,
          worker,
          peer,
          result,
          routing,
          { nextReviewCycle },
        );
        peerPass = result;
        if (decision.action === 'peer') worker = peer;
        passCeiling = Math.max(passCeiling, pass + 1);
        pass += 1;
        continue;
      }

      if (passApprovesRevision(result)) approvals.set(worker.name, result.revision);

      if (approvals.get('A') === currentRevision && approvals.get('B') === currentRevision) {
        this.ui.converged(currentRevision, pass);
        return { revision: currentRevision, evidence };
      }

      if (pass >= passCeiling) {
        const additional = await this.requestLimitExtension('worker_passes', pass, passCeiling);
        passCeiling = pass + additional;
        this.ui.phase('A/B limit extended', `Continuing convergence for up to ${additional} additional review/fix pass(es).`);
      }

      peerPass = result;
      worker = worker === workerA ? workerB : workerA;
      pass += 1;
    }
  }

  async runTask(factory, task, taskSessionKey, routing, taskResumeState = null) {
    if (routing.route === 'trivial') return super.runTrivialTask(factory, task, taskSessionKey, routing);
    return this.runFullTask(factory, task, taskSessionKey, routing, taskResumeState);
  }

  async runFullTask(factory, task, taskSessionKey, routing, taskResumeState = null) {
    let workerA;
    let workerB;
    let reviewer;
    const route = routing.route;
    try {
      workerA = await factory.createWorker(taskSessionKey, 'A', route, routing.risk);
      workerB = await factory.createWorker(taskSessionKey, 'B', route, routing.risk);
      reviewer = await factory.createReviewer(taskSessionKey, route, routing.risk);
      this.sessions.push(workerA.session, workerB.session, reviewer.session);
      this.ui.agentConfiguration([
        { role: 'A', model: workerA.model.name ?? workerA.model.id, effort: workerA.reasoningEffort },
        { role: 'B', model: workerB.model.name ?? workerB.model.id, effort: workerB.reasoningEffort },
        { role: 'Strong reviewer', model: reviewer.model.name ?? reviewer.model.id, effort: reviewer.reasoningEffort },
      ]);

      if (taskResumeState?.stage === 'worker_blocked' && taskResumeState.blockedPass?.report?.verdict === 'blocked') {
        const nextReviewCycle = Math.max(1, Number(taskResumeState.nextReviewCycle) || 1);
        this.ui.phase(
          'Resuming blocked worker',
          `Continuing task ${task.id} from a saved Worker ${taskResumeState.worker ?? taskResumeState.blockedPass.worker} blocker on the preserved workspace revision.`,
        );
        const convergence = await this.convergeFromPass(
          task,
          workerA,
          workerB,
          taskResumeState.blockedPass,
          routing,
          { nextReviewCycle },
        );
        await this.saveTaskCheckpoint({
          stage: 'strong_review_pending',
          nextReviewCycle,
          evidence: convergence.evidence,
          routing,
        });
        await this.checkAiCreditBudget(`before strong-review cycle ${nextReviewCycle} for ${task.id}`);
        await this.runStrongReview(task, workerA, workerB, reviewer, convergence.evidence, routing, { startReviewCycle: nextReviewCycle });
        return { route, escalated: false };
      }

      if (taskResumeState?.stage === 'strong_review_findings' && Array.isArray(taskResumeState.findings) && taskResumeState.findings.length) {
        this.ui.phase(
          'Resuming remediation',
          `Continuing task ${task.id} from strong-review cycle ${taskResumeState.reviewCycle}: ${taskResumeState.findings.length} saved finding(s) still require remediation. Fresh task-local sessions will work against the saved workspace revision.`,
        );
        const remediation = await this.runWorkerPass(workerA, task, 'FIX_STRONG_REVIEW_FINDINGS', taskResumeState.findings, null);
        this.ui.passResult('A', remediation.report, remediation.changed, remediation.revision, remediation);
        const nextReviewCycle = Math.max(1, Number(taskResumeState.reviewCycle) + 1 || 1);
        const convergence = await this.convergeFromPass(
          task,
          workerA,
          workerB,
          remediation,
          routing,
          { nextReviewCycle },
        );
        await this.saveTaskCheckpoint({
          stage: 'strong_review_pending',
          nextReviewCycle,
          evidence: convergence.evidence,
          routing,
        });
        await this.checkAiCreditBudget(`before strong-review cycle ${nextReviewCycle} for ${task.id}`);
        await this.runStrongReview(task, workerA, workerB, reviewer, convergence.evidence, routing, { startReviewCycle: nextReviewCycle });
        return { route, escalated: false };
      }

      if (taskResumeState?.stage === 'strong_review_pending') {
        const nextReviewCycle = Math.max(1, Number(taskResumeState.nextReviewCycle) || 1);
        this.ui.phase(
          'Resuming strong review',
          `Continuing task ${task.id} at strong-review cycle ${nextReviewCycle} on the saved converged workspace revision. Fresh task-local sessions will inspect the current revision rather than rerunning implementation.`,
        );
        await this.checkAiCreditBudget(`before resumed strong-review cycle ${nextReviewCycle} for ${task.id}`);
        await this.runStrongReview(
          task,
          workerA,
          workerB,
          reviewer,
          Array.isArray(taskResumeState.evidence) ? taskResumeState.evidence : [],
          routing,
          { startReviewCycle: nextReviewCycle },
        );
        return { route, escalated: false };
      }

      if (taskResumeState?.stage === 'strong_review_blocked') {
        const reviewCycle = Math.max(1, Number(taskResumeState.reviewCycle) || 1);
        this.ui.phase(
          'Resuming blocked strong review',
          `Continuing task ${task.id} at the saved blocked strong-review cycle ${reviewCycle}. The converged workspace revision is unchanged.`,
        );
        await this.runStrongReview(
          task,
          workerA,
          workerB,
          reviewer,
          Array.isArray(taskResumeState.evidence) ? taskResumeState.evidence : [],
          routing,
          { startReviewCycle: reviewCycle },
        );
        return { route, escalated: false };
      }

      const initial = await this.runWorkerPass(workerA, task, 'IMPLEMENT', null, null);
      this.ui.passResult('A', initial.report, initial.changed, initial.revision, initial);

      const convergence = await this.convergeFromPass(task, workerA, workerB, initial, routing, { nextReviewCycle: 1 });
      await this.saveTaskCheckpoint({
        stage: 'strong_review_pending',
        nextReviewCycle: 1,
        evidence: convergence.evidence,
        routing,
      });
      await this.checkAiCreditBudget(`before strong review for ${task.id}`);
      await this.runStrongReview(task, workerA, workerB, reviewer, convergence.evidence, routing, { startReviewCycle: 1 });
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
    { startReviewCycle = 1 } = {},
  ) {
    let evidence = [...initialEvidence];
    let reviewCycle = Math.max(1, Number(startReviewCycle) || 1);
    let reviewCeiling = reviewCycle + Math.max(1, Number(this.maxReviewerCycles) || 3) - 1;

    while (true) {
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
          `Task workflow: ${routing.route}; task risk: ${routing.risk}.`,
          formatValidationEvidence(evidence),
          '',
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
      if (review.verdict === 'blocked') {
        const decision = await this.requestReviewerBlockedDecision(task, review, reviewCycle, evidence, routing);
        if (decision.action === 'retry') {
          this.ui.phase('Retrying strong reviewer', `Strong-review cycle ${reviewCycle} will be retried on the same converged workspace revision.`);
          continue;
        }
      }
      if (!review.findings?.length) throw new Error('Strong reviewer returned findings without any actionable findings.');

      await this.saveTaskCheckpoint({
        stage: 'strong_review_findings',
        reviewCycle,
        findings: review.findings,
        evidence,
        routing,
      });
      await this.checkAiCreditBudget(`after strong-review cycle ${reviewCycle} for ${task.id}`);

      if (reviewCycle >= reviewCeiling) {
        const additional = await this.requestLimitExtension('reviewer_cycles', reviewCycle, reviewCeiling);
        reviewCeiling = reviewCycle + additional;
        this.ui.phase('Review limit extended', `Continuing strong review for up to ${additional} additional remediation cycle(s).`);
      }

      this.ui.phase(
        'Remediation',
        `Strong reviewer returned ${review.findings.length} finding(s) in cycle ${reviewCycle}; Worker A remediates, then A/B convergence repeats.`,
      );
      const remediation = await this.runWorkerPass(workerA, task, 'FIX_STRONG_REVIEW_FINDINGS', review.findings, null);
      this.ui.passResult('A', remediation.report, remediation.changed, remediation.revision, remediation);
      const convergence = await this.convergeFromPass(
        task,
        workerA,
        workerB,
        remediation,
        routing,
        { nextReviewCycle: reviewCycle + 1 },
      );
      evidence = convergence.evidence;
      await this.saveTaskCheckpoint({
        stage: 'strong_review_pending',
        nextReviewCycle: reviewCycle + 1,
        evidence,
        routing,
      });
      await this.checkAiCreditBudget(`before strong-review cycle ${reviewCycle + 1} for ${task.id}`);
      reviewCycle += 1;
    }
  }

  async run(userRequest, resumeState = null) {
    await assertGitRepository(this.workspace);
    this.checkCancelled();

    const factory = this.sessionFactory();

    let coordinator = null;
    let plan;
    let startTaskIndex = 0;
    let planningUsage = null;
    const canReusePlan = Boolean(resumeState?.plan);

    if (canReusePlan) {
      plan = resumeState.plan;
      startTaskIndex = resumeState.startTaskIndex;
      this.stats = { ...defaultStats(plan.tasks.length), ...resumeState.stats, tasks: plan.tasks.length };
      const task = plan.tasks[startTaskIndex];
      const preciseStage = resumeState.taskState?.stage;
      const detail = resumeState.currentTaskIndex === null
        ? `Continuing with task ${startTaskIndex + 1}/${plan.tasks.length}: ${task.title}.`
        : preciseStage
          ? `Resuming interrupted task ${startTaskIndex + 1}/${plan.tasks.length} from saved stage ${preciseStage}: ${task.title}. Completed tasks will not be rerun.`
          : `Restarting interrupted task ${startTaskIndex + 1}/${plan.tasks.length} from the current workspace state: ${task.title}. Completed tasks will not be rerun.`;
      this.ui.phase('Resuming', detail);
    } else {
      this.stats = defaultStats(0);
      await this.saveCheckpoint({
        request: userRequest,
        plan: null,
        status: 'running',
        nextTaskIndex: 0,
        currentTaskIndex: null,
        stage: 'planning',
      });
      this.ui.phase(
        resumeState ? 'Resuming planning' : 'Planning',
        resumeState
          ? 'The prior run stopped before a plan was accepted. The coordinator is re-running planning from the saved user request.'
          : 'Coordinator is inspecting the repository, classifying risk, and choosing the proportionate workflow.',
      );
      coordinator = await factory.createCoordinator();
      this.sessions.push(coordinator.session);
      this.ui.agentConfiguration([
        { role: 'Coordinator', model: coordinator.model.name ?? coordinator.model.id, effort: coordinator.reasoningEffort },
      ]);

      const beforePlan = await this.revisionProvider(this.workspace);
      const planStartedAt = Date.now();
      plan = await requireReport(
        coordinator.session,
        coordinator.sink,
        `User request:\n\n${userRequest}\n\nInspect only what is needed, clarify material ambiguity, classify every task, and submit the smallest proportionate plan with report_plan. For read_only tasks, perform the inspection now and include the answer in task.result.`,
        'report_plan',
        this.agentTurnTimeoutMs,
      );
      const afterPlan = await this.revisionProvider(this.workspace);
      planningUsage = await this.finishTurn(coordinator, planStartedAt);
      if (beforePlan !== afterPlan) throw new Error('Coordinator changed the workspace despite the read-only contract.');
      this.stats = defaultStats(plan.tasks.length);
    }

    const routings = plan.tasks.map((task) => normalizeTaskRoute(task, this.routingMode));
    for (let index = 0; index < plan.tasks.length; index += 1) {
      if (routings[index].route === 'read_only' && !plan.tasks[index].result) {
        throw new Error(`Coordinator classified task ${plan.tasks[index].id} as read_only but did not provide task.result.`);
      }
    }

    this.ui.plan(plan, routings);
    if (planningUsage) this.ui.usageProgress(planningUsage);
    await this.saveCheckpoint({
      request: userRequest,
      plan,
      status: 'ready',
      nextTaskIndex: startTaskIndex,
      currentTaskIndex: canReusePlan ? resumeState.currentTaskIndex : null,
      stage: canReusePlan ? 'resume_ready' : 'plan_complete',
      taskState: canReusePlan ? resumeState.taskState ?? null : null,
    });
    await this.checkAiCreditBudget('after planning');

    for (let index = startTaskIndex; index < plan.tasks.length; index += 1) {
      this.checkCancelled();
      const task = plan.tasks[index];
      const routing = routings[index];
      const policy = routePolicy(routing.route, routing.risk);

      let taskResumeState = null;
      if (resumeState?.currentTaskIndex === index && resumeState.taskState) {
        let currentRevision;
        try {
          currentRevision = await this.revisionProvider(this.workspace);
        } catch {
          currentRevision = undefined;
        }
        if (resumeState.revision && currentRevision === resumeState.revision) {
          taskResumeState = resumeState.taskState;
        } else {
          this.ui.phase(
            'Resume fallback',
            `The workspace no longer matches the saved ${resumeState.taskState.stage} checkpoint for task ${task.id}; restarting only this task against the current workspace instead of applying stale review state.`,
          );
        }
      }

      await this.saveCheckpoint({
        request: userRequest,
        plan,
        status: 'running',
        nextTaskIndex: index,
        currentTaskIndex: index,
        stage: taskResumeState?.stage ?? 'task_started',
        taskState: taskResumeState,
      });
      this.ui.taskStarted(task, index + 1, plan.tasks.length, routing, policy);

      let taskStartedClean = false;
      if (this.taskCommitMode === 'safe' && routing.route !== 'read_only') {
        try {
          taskStartedClean = await isWorkingTreeClean(this.workspace);
          if (!taskStartedClean) {
            this.ui.taskCommitSkipped(task, 'safe mode requires a clean worktree at task start; existing changes will not be swept into an automatic commit');
          }
        } catch (error) {
          this.ui.taskCommitSkipped(task, `could not inspect worktree state: ${error.message ?? String(error)}`);
        }
      }

      this.activeTaskCheckpointContext = { request: userRequest, plan, index };
      let outcome = null;
      try {
        if (routing.route === 'read_only') {
          this.stats.readOnly += 1;
          this.ui.readOnlyResult(task);
        } else {
          outcome = await this.runTask(factory, task, `${index + 1}-${task.id}`, routing, taskResumeState);
          if (outcome.route === 'trivial') this.stats.trivial += 1;
          else this.stats.full += 1;
          if (outcome.escalated) this.stats.escalations += 1;
        }
      } finally {
        this.activeTaskCheckpointContext = null;
      }

      if (routing.route !== 'read_only' && this.taskCommitMode === 'safe' && taskStartedClean) {
        try {
          const sha = await createTaskCommit(this.workspace, task);
          if (sha) this.ui.taskCommitted(task, sha);
        } catch (error) {
          this.ui.taskCommitSkipped(task, `git commit failed; accepted task changes remain in the worktree: ${error.message ?? String(error)}`);
        }
      }

      this.ui.taskCompleted(task, routing.route === 'read_only' ? 'read_only' : outcome.route);

      await this.saveCheckpoint({
        request: userRequest,
        plan,
        status: 'running',
        nextTaskIndex: index + 1,
        currentTaskIndex: null,
        stage: 'task_complete',
        taskState: null,
      });
      await this.checkAiCreditBudget(`after task ${task.id}`);
    }

    if (coordinator) await this.usage.refresh(coordinator.usageName, coordinator.session);
    const finalUsage = this.getUsageSummary();
    this.ui.phase('Complete', `All ${plan.tasks.length} task(s) completed under their enforced workflow routes.`);
    this.ui.runSummary(finalUsage, this.stats);
    await this.saveCheckpoint({
      request: userRequest,
      plan,
      status: 'complete',
      nextTaskIndex: plan.tasks.length,
      currentTaskIndex: null,
      stage: 'complete',
      taskState: null,
    });
    return { plan, usage: finalUsage, stats: { ...this.stats } };
  }
}

module.exports = {
  ResumableConvergentEngine,
};
