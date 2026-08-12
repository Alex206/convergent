'use strict';

const { ResumableConvergentEngine } = require('./resumable-engine');
const { requireReport, taskPrompt, formatValidationEvidence } = require('./engine');
const { formatTaskChangeManifest } = require('./task-change-manifest');
const { reconcileExplicitValidationBlocker } = require('./report-blocker');
const { pauseWorkflow } = require('./control');
const { SessionFactory } = require('../copilot/session-factory');

function checkpointPass(pass) {
  if (!pass) return null;
  return {
    worker: pass.worker,
    report: pass.report,
    changed: Boolean(pass.changed),
    revision: pass.revision,
  };
}

function queueRecoveryInstruction(session, guidance) {
  const text = String(guidance ?? '').trim();
  if (!session || !text || typeof session.sendAndWait !== 'function') return false;
  const previous = session.sendAndWait.bind(session);
  let pending = true;
  session.sendAndWait = (options, timeoutMs) => {
    if (!pending) return previous(options, timeoutMs);
    pending = false;
    session.sendAndWait = previous;
    const prompt = [
      options?.prompt ?? '',
      '',
      'RECOVERY GUIDANCE FROM CONVERGENT/OPERATOR:',
      text,
      'Apply this guidance to the current task, but do not treat it as permission to bypass acceptance criteria, convergence, validation, or the strong-review gate.',
    ].join('\n');
    return previous({ ...options, prompt }, timeoutMs);
  };
  return true;
}

function appendTaskChangeManifestPrompt(prompt, manifest) {
  if (!manifest) return String(prompt ?? '');
  return [
    String(prompt ?? ''),
    '',
    formatTaskChangeManifest(manifest, 'Deterministic task change manifest for this review'),
    'Start with these exact task-change paths instead of rediscovering file locations from Git status or broad repository searches.',
  ].join('\n');
}

class RecoveryConvergentEngine extends ResumableConvergentEngine {
  constructor(options) {
    super(options);
    this.activeTaskChangeContext = null;
  }

  recoveryFactory() {
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
    });
  }

  async runTask(factory, task, taskSessionKey, routing, taskResumeState = null) {
    const previousContext = this.activeTaskChangeContext;
    const taskContext = await this.createTaskContext(factory);
    this.activeTaskChangeContext = taskContext;
    try {
      return await super.runTask(factory, task, taskSessionKey, routing, taskResumeState);
    } finally {
      this.activeTaskChangeContext = previousContext;
    }
  }

  async runWorkerPass(worker, task, mode, findings, peerPass = null, taskContext = null) {
    const result = await super.runWorkerPass(
      worker,
      task,
      mode,
      findings,
      peerPass,
      taskContext ?? this.activeTaskChangeContext,
    );
    const reconciled = reconcileExplicitValidationBlocker(result.report);
    if (reconciled.correction) {
      this.ui?.log?.(`Worker ${worker.name} verdict reconciled by Convergent: ${reconciled.correction}`);
    }
    return {
      ...result,
      report: reconciled.report,
      validationBlockerCorrection: reconciled.correction,
    };
  }

  async consultRecoveryCoordinator(task, kind, detail, { allowPeer = false } = {}) {
    const factory = this.recoveryFactory();
    const coordinator = await factory.createRecoveryCoordinator(task.id, kind);
    this.sessions.push(coordinator.session);
    const allowed = allowPeer ? 'peer, retry, ask_user, or pause' : 'retry, ask_user, or pause (peer is not available for this required reviewer gate)';
    let operatorAnswer = '';

    try {
      this.ui?.phase?.('Recovery assessment', `Strong coordinator is assessing the ${kind} blocker for task ${task.id} before Convergent asks you or spends another implementation/review turn.`);
      let startedAt = Date.now();
      let report = await requireReport(
        coordinator.session,
        coordinator.sink,
        [
          taskPrompt(task),
          '',
          `BLOCKER KIND: ${kind}`,
          `Allowed final actions: ${allowed}.`,
          `Workspace changed by blocked pass: ${detail.changed ? 'yes' : 'no/unknown'}.`,
          detail.workspaceFingerprint ? `Current Convergent workspace fingerprint: ${detail.workspaceFingerprint}. This is an opaque workspace-state hash, not a Git commit/ref.` : '',
          detail.summary ? `Blocked-agent summary:\n${detail.summary}` : '',
          detail.checks?.length ? `Checks/evidence already reported:\n${detail.checks.map((item) => `- ${item}`).join('\n')}` : '',
          detail.evidence?.length ? formatValidationEvidence(detail.evidence) : '',
          '',
          'Decide the least wasteful safe recovery action. Inspect only a small amount of read-only repository/environment context if it resolves the blocker. Use ask_user only for a genuinely missing operator fact or decision.',
        ].filter(Boolean).join('\n'),
        'report_recovery',
        this.agentTurnTimeoutMs,
      );
      await this.finishTurn(coordinator, startedAt);

      if (!allowPeer && report.action === 'peer') {
        startedAt = Date.now();
        report = await requireReport(
          coordinator.session,
          coordinator.sink,
          'Peer continuation is not an allowed final action for this required reviewer gate. Choose retry, ask_user, or pause now and call report_recovery once.',
          'report_recovery',
          this.agentTurnTimeoutMs,
        );
        await this.finishTurn(coordinator, startedAt);
      }

      if (report.action === 'ask_user') {
        const response = await this.userInputHandler?.({ question: report.question });
        operatorAnswer = String(response?.answer ?? '').trim();
        if (!operatorAnswer || /^user cancelled/i.test(operatorAnswer)) {
          return { action: 'pause', rationale: 'Operator did not provide the requested recovery information.', guidance: report.guidance };
        }
        this.ui?.log?.(`Recovery coordinator asked operator for task ${task.id}: ${report.question}; answer received.`);
        startedAt = Date.now();
        report = await requireReport(
          coordinator.session,
          coordinator.sink,
          [
            `Operator answer to your recovery question:\n${operatorAnswer}`,
            '',
            `Choose the final action now from: ${allowPeer ? 'peer, retry, pause' : 'retry, pause'}. Do not ask_user again.`,
            'Preserve useful operator context in guidance for the selected agent.',
          ].join('\n'),
          'report_recovery',
          this.agentTurnTimeoutMs,
        );
        await this.finishTurn(coordinator, startedAt);
        if (report.action === 'ask_user' || (!allowPeer && report.action === 'peer')) {
          return { action: 'pause', rationale: 'Recovery coordinator did not produce an allowed final action after operator input.', guidance: operatorAnswer };
        }
      }

      const guidance = [report.guidance, operatorAnswer ? `Operator context: ${operatorAnswer}` : '']
        .filter(Boolean)
        .join('\n');
      this.ui?.log?.(`Recovery coordinator decision for ${kind} on ${task.id}: ${report.action}; ${report.rationale}`);
      this.ui?.audit?.({ type: 'recovery_decision', taskId: task.id, kind, report, operatorAnswer });
      return { action: report.action, rationale: report.rationale, guidance };
    } finally {
      await coordinator.session.disconnect?.().catch(() => {});
      this.sessions = this.sessions.filter((session) => session !== coordinator.session);
    }
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
      `Worker ${blockedWorker.name} could not fully complete or validate task ${task.id}. The current workspace fingerprint is preserved${result.changed ? ' and contains worker changes' : ''}; the strong coordinator will assess recovery before another expensive agent turn.`,
    );

    const decision = await this.consultRecoveryCoordinator(task, `worker-${blockedWorker.name}`, {
      changed: result.changed,
      workspaceFingerprint: result.revision,
      summary: result.report?.summary,
      checks: result.report?.checks ?? [],
    }, { allowPeer: true });

    if (decision.action === 'peer') {
      queueRecoveryInstruction(peerWorker.session, decision.guidance || decision.rationale);
      return { action: 'peer', guidance: decision.guidance };
    }
    if (decision.action === 'retry') {
      queueRecoveryInstruction(blockedWorker.session, decision.guidance || decision.rationale);
      return { action: 'retry', guidance: decision.guidance };
    }

    pauseWorkflow(
      `Paused because Worker ${blockedWorker.name} is blocked on task ${task.id}. The blocker, current workspace fingerprint, and recovery assessment were preserved.`,
      { kind: 'worker_blocked', task: task.id, worker: blockedWorker.name, summary: result.report?.summary, recovery: decision },
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
      `Strong reviewer could not complete cycle ${reviewCycle} for task ${task.id}. The strong coordinator will distinguish environment/validation ambiguity from a true review blocker before retrying or asking you.`,
    );

    let workspaceFingerprint;
    try { workspaceFingerprint = await this.revisionProvider(this.workspace); } catch {}
    const decision = await this.consultRecoveryCoordinator(task, 'strong-reviewer', {
      workspaceFingerprint,
      summary: review.summary,
      checks: review.checks ?? [],
      evidence,
    }, { allowPeer: false });

    if (decision.action === 'retry') {
      queueRecoveryInstruction(this.activeReviewerForRecovery?.session, decision.guidance || decision.rationale);
      return { action: 'retry', guidance: decision.guidance };
    }

    pauseWorkflow(
      `Paused because the strong reviewer is blocked on task ${task.id} at cycle ${reviewCycle}. The review boundary and recovery assessment were checkpointed.`,
      { kind: 'strong_review_blocked', task: task.id, reviewCycle, summary: review.summary, recovery: decision },
    );
  }

  async runStrongReview(task, workerA, workerB, reviewer, ...rest) {
    this.activeReviewerForRecovery = reviewer;
    const session = reviewer?.session;
    const previousSendAndWait = typeof session?.sendAndWait === 'function'
      ? session.sendAndWait.bind(session)
      : null;

    if (previousSendAndWait && this.activeTaskChangeContext) {
      session.sendAndWait = async (options, timeoutMs) => {
        const manifest = await this.currentTaskChangeManifest(this.activeTaskChangeContext);
        return previousSendAndWait({
          ...options,
          prompt: appendTaskChangeManifestPrompt(options?.prompt, manifest),
        }, timeoutMs);
      };
    }

    try {
      return await super.runStrongReview(task, workerA, workerB, reviewer, ...rest);
    } finally {
      if (previousSendAndWait) session.sendAndWait = previousSendAndWait;
      if (this.activeReviewerForRecovery === reviewer) this.activeReviewerForRecovery = null;
    }
  }
}

module.exports = {
  RecoveryConvergentEngine,
  queueRecoveryInstruction,
  appendTaskChangeManifestPrompt,
};
