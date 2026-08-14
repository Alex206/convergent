'use strict';

const { ResumableConvergentEngine } = require('./resumable-engine');
const { requireReport, taskPrompt, formatValidationEvidence } = require('./engine');
const { formatTaskChangeManifest } = require('./task-change-manifest');
const { operatorPrerequisiteEvidence } = require('./report-blocker');
const { usesPeerConvergence } = require('./routing');
const { pauseWorkflow } = require('./control');

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
    return this.sessionFactory();
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
    return super.runWorkerPass(
      worker,
      task,
      mode,
      findings,
      peerPass,
      taskContext ?? this.activeTaskChangeContext,
    );
  }

  async consultRecoveryCoordinator(task, kind, detail, { allowPeer = false } = {}) {
    const factory = this.recoveryFactory();
    const coordinator = await factory.createRecoveryCoordinator(task.id, kind);
    this.sessions.push(coordinator.session);
    const allowed = allowPeer ? 'peer, retry, ask_user, or pause' : 'retry, ask_user, or pause (peer is not available for this recovery path)';
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
          'Decide the least wasteful safe recovery action. Inspect only a small amount of read-only repository/environment context if it resolves the blocker. A required validation that is blocked by a missing operator-controlled token, credential, secret, or environment prerequisite must not be reclassified as acceptable or retried unchanged: ask_user for the missing prerequisite or guidance. Use ask_user only for a genuinely missing operator fact or decision.',
        ].filter(Boolean).join('\n'),
        'report_recovery',
        this.agentTurnTimeoutMs,
      );
      await this.finishTurn(coordinator, startedAt);

      const prerequisite = operatorPrerequisiteEvidence(detail);
      if (prerequisite && (report.action === 'retry' || report.action === 'peer')) {
        this.ui?.log?.(`Recovery coordinator attempted ${report.action} while an operator-controlled validation prerequisite is still missing; requiring operator input before another worker turn.`);
        this.ui?.audit?.({
          type: 'recovery_operator_prerequisite_required',
          taskId: task.id,
          kind,
          attemptedAction: report.action,
          prerequisite,
        });
        report = {
          action: 'ask_user',
          rationale: 'Required validation remains blocked by an operator-controlled environment prerequisite, so retrying or handing to the peer without new operator context would only repeat the same blocker.',
          question: 'A required validation is blocked by a missing environment prerequisite (for example a token, credential, secret, or environment variable). What value or safe recovery guidance should Convergent use for this validation?',
          guidance: report.guidance,
        };
      }

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
            'Preserve useful operator context in guidance for the selected agent. A retry/peer action must use the operator context to resolve or meaningfully re-evaluate the blocker; do not simply accept the same blocked required validation.',
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
      const authorizedCredentialNames = this.operatorCredentialGuard?.authorizeFromOperatorGuidance(guidance) ?? [];
      if (authorizedCredentialNames.length) {
        this.ui?.log?.(`Operator recovery authorized credential variable name(s) for retry: ${authorizedCredentialNames.join(', ')}.`);
      }
      this.ui?.log?.(`Recovery coordinator decision for ${kind} on ${task.id}: ${report.action}; ${report.rationale}`);
      this.ui?.audit?.({
        type: 'recovery_decision',
        taskId: task.id,
        kind,
        report,
        operatorAnswer,
        operatorContextProvided: Boolean(operatorAnswer),
        authorizedCredentialNames,
      });
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

    const allowPeer = Boolean(peerWorker) && usesPeerConvergence(routing);
    const decision = await this.consultRecoveryCoordinator(task, `worker-${blockedWorker.name}`, {
      changed: result.changed,
      workspaceFingerprint: result.revision,
      summary: result.report?.summary,
      checks: result.report?.checks ?? [],
    }, { allowPeer });

    if (decision.action === 'peer' && allowPeer) {
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
