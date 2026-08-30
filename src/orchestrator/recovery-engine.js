'use strict';

const { ResumableConvergentEngine } = require('./resumable-engine');
const {
  requireReport,
  taskPrompt,
  formatValidationEvidence,
  reconcileDeterministicIntegrity,
} = require('./engine');
const { formatTaskChangeManifest } = require('./task-change-manifest');
const { operatorPrerequisiteEvidence } = require('./report-blocker');
const { usesPeerConvergence } = require('./routing');
const { pauseWorkflow } = require('./control');
const { runArchitectureAssessment, formatArchitectureAssessment } = require('./architecture-advisor');
const { usageDelta } = require('./usage');
const { toolTraceSnapshot } = require('../copilot/session-factory');
const {
  toolTraceDelta,
  createReviewerMutationIncident,
  formatReviewerMutationIncident,
} = require('./reviewer-integrity');
const {
  normalizeReviewDossier,
  appendReviewDossier,
  formatReviewDossier,
} = require('./review-dossier');

const MAX_REVIEWER_MUTATION_RETRIES = 2;

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

function taskWithArchitectureAssessment(task, assessment) {
  if (!assessment) return task;
  return {
    ...task,
    description: [task.description, '', formatArchitectureAssessment(assessment)].filter(Boolean).join('\n'),
  };
}

function reviewerMutationFinding(incident, decision = {}) {
  const paths = (incident.changedPaths ?? []).map((entry) => entry.path).filter(Boolean);
  const pathText = paths.length ? ` Changed path(s): ${paths.join(', ')}.` : '';
  return {
    severity: 'high',
    title: 'Revalidate reviewer-modified workspace',
    description: [
      `The read-only strong reviewer changed the workspace during review cycle ${incident.reviewCycle}.`,
      'Do not assume the reviewer change is correct or incorrect merely because it is explainable. Independently inspect the current revision, keep/rework/revert the reviewer-caused change as technically appropriate, and validate the task before returning it to the strong-review gate.',
      pathText,
      decision.guidance ? `Adjudicator guidance: ${decision.guidance}` : '',
    ].filter(Boolean).join(' '),
  };
}

class RecoveryConvergentEngine extends ResumableConvergentEngine {
  constructor(options) {
    super(options);
    this.activeTaskChangeContext = null;
    this.activeReviewDossier = normalizeReviewDossier(null);

    // The base resumable engine persists workflow state. Enrich every checkpoint
    // with the cumulative request-lifetime usage ledger so /resume continues the
    // original accounting rather than starting from zero.
    const persistCheckpoint = this.onCheckpoint;
    this.onCheckpoint = async (state) => persistCheckpoint({
      ...state,
      usage: this.usage.exportState(),
    });
  }

  async run(userRequest, resumeState = null) {
    if (resumeState?.usage) {
      const restored = this.usage.restore(resumeState.usage);
      if (restored) {
        const summary = this.getUsageSummary();
        this.ui?.log?.(`Restored cumulative request usage before resume: ${summary.inputTokens} input + ${summary.outputTokens} output tokens across ${summary.turns} turn(s).`);
        this.ui?.audit?.({ type: 'usage_restored', usage: summary });
      }
    }
    return super.run(userRequest, resumeState);
  }

  async saveTaskCheckpoint(taskState) {
    const requestedDossier = taskState?.reviewDossier;
    if (requestedDossier) this.activeReviewDossier = normalizeReviewDossier(requestedDossier);
    const dossier = normalizeReviewDossier(this.activeReviewDossier);
    return super.saveTaskCheckpoint({
      ...taskState,
      ...(dossier.cycles.length ? { reviewDossier: dossier } : {}),
    });
  }

  recoveryFactory() {
    return this.sessionFactory();
  }

  async runTask(factory, task, taskSessionKey, routing, taskResumeState = null) {
    const previousContext = this.activeTaskChangeContext;
    const previousDossier = this.activeReviewDossier;
    this.activeReviewDossier = normalizeReviewDossier(taskResumeState?.reviewDossier);
    const savedAssessment = taskResumeState?.routing?.architectureAssessment ?? null;
    let effectiveRouting = savedAssessment ? { ...routing, architectureAssessment: savedAssessment } : { ...routing };

    if (effectiveRouting.needsArchitect && !effectiveRouting.architectureAssessment) {
      const assessment = await runArchitectureAssessment(this, factory, task, effectiveRouting);
      effectiveRouting = { ...effectiveRouting, architectureAssessment: assessment };
      await this.saveTaskCheckpoint({ stage: 'architecture_assessed', routing: effectiveRouting });
    }

    const effectiveTask = taskWithArchitectureAssessment(task, effectiveRouting.architectureAssessment);
    const taskContext = await this.createTaskContext(factory);
    this.activeTaskChangeContext = taskContext;
    try {
      return await super.runTask(factory, effectiveTask, taskSessionKey, effectiveRouting, taskResumeState);
    } finally {
      this.activeTaskChangeContext = previousContext;
      this.activeReviewDossier = previousDossier;
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

  async consultReviewerMutationCoordinator(task, incident, routing) {
    const factory = this.recoveryFactory();
    const coordinator = await factory.createRecoveryCoordinator(task.id, `reviewer-integrity-r${incident.reviewCycle}`);
    this.sessions.push(coordinator.session);
    let operatorAnswer = '';

    try {
      this.ui?.phase?.(
        'Reviewer integrity assessment',
        `The strong reviewer changed the workspace in R${incident.reviewCycle}. A strong coordinator is classifying the incident before any further acceptance decision.`,
      );
      let startedAt = Date.now();
      let report = await requireReport(
        coordinator.session,
        coordinator.sink,
        [
          taskPrompt(task),
          '',
          `Task workflow: ${routing.route}; task risk: ${routing.risk}.`,
          formatReviewerMutationIncident(incident),
          '',
          'This is a reviewer workspace-integrity incident, not permission for the reviewer to self-approve its change.',
          'Choose one action:',
          '- retry: the incident is understandable enough to continue, but Convergent MUST first send the changed revision to Worker A (and Worker B when this route requires peer convergence) for independent revalidation; only after that may a later strong-review call accept it.',
          '- ask_user: a material operator fact/decision is required to classify the side effect safely.',
          '- pause: attribution or safety is too uncertain to continue automatically.',
          'Peer is not a valid final action here. Do not edit files. Inspect only a small targeted amount of read-only context if it materially improves classification.',
        ].join('\n'),
        'report_recovery',
        this.agentTurnTimeoutMs,
      );
      await this.finishTurn(coordinator, startedAt);

      if (report.action === 'peer') {
        startedAt = Date.now();
        report = await requireReport(
          coordinator.session,
          coordinator.sink,
          'Peer is not a valid integrity-adjudication action. Choose retry, ask_user, or pause now. Remember: retry means independent implementation-worker revalidation before another reviewer call.',
          'report_recovery',
          this.agentTurnTimeoutMs,
        );
        await this.finishTurn(coordinator, startedAt);
      }

      if (report.action === 'ask_user') {
        const response = await this.userInputHandler?.({ question: report.question });
        operatorAnswer = String(response?.answer ?? '').trim();
        if (!operatorAnswer || /^user cancelled/i.test(operatorAnswer)) {
          return { action: 'pause', rationale: 'Operator did not provide the requested integrity-classification input.', guidance: report.guidance };
        }
        startedAt = Date.now();
        report = await requireReport(
          coordinator.session,
          coordinator.sink,
          [
            `Operator answer:\n${operatorAnswer}`,
            '',
            'Choose retry or pause now. Do not ask_user again and do not choose peer. Retry still requires independent worker revalidation before another strong-review call.',
          ].join('\n'),
          'report_recovery',
          this.agentTurnTimeoutMs,
        );
        await this.finishTurn(coordinator, startedAt);
      }

      if (report.action !== 'retry') {
        return {
          action: 'pause',
          rationale: report.rationale || 'Reviewer mutation could not be classified safely for automatic continuation.',
          guidance: [report.guidance, operatorAnswer ? `Operator context: ${operatorAnswer}` : ''].filter(Boolean).join('\n'),
        };
      }

      const decision = {
        action: 'retry',
        rationale: report.rationale,
        guidance: [report.guidance, operatorAnswer ? `Operator context: ${operatorAnswer}` : ''].filter(Boolean).join('\n'),
      };
      this.ui?.log?.(`Reviewer-integrity adjudication for task ${task.id} R${incident.reviewCycle}: revalidate via worker(s); ${decision.rationale}`);
      this.ui?.audit?.({
        type: 'reviewer_integrity_decision',
        taskId: task.id,
        reviewCycle: incident.reviewCycle,
        incident,
        decision,
      });
      return decision;
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

  async captureIntegrityState() {
    try {
      return await this.changeStateProvider(this.workspace);
    } catch (error) {
      this.ui?.log?.(`Reviewer-integrity change-state capture unavailable: ${error?.message ?? String(error)}`);
      return null;
    }
  }

  async revalidateReviewerMutation(task, workerA, workerB, routing, incident, decision) {
    const finding = reviewerMutationFinding(incident, decision);
    queueRecoveryInstruction(workerA?.session, [
      decision.guidance || decision.rationale,
      'This continuation is specifically an independent revalidation of a workspace change made by the read-only strong reviewer. Do not merely accept the reviewer change because the adjudicator found it explainable.',
    ].filter(Boolean).join('\n'));

    this.ui?.phase?.(
      'Reviewer-change revalidation',
      usesPeerConvergence(routing)
        ? `Worker A will independently inspect the reviewer-modified revision, then A/B convergence must approve the resulting fingerprint before strong review resumes.`
        : 'Worker A will independently inspect the reviewer-modified revision before strong review resumes.',
    );
    const pass = await this.runWorkerPass(
      workerA,
      task,
      'FIX_STRONG_REVIEW_FINDINGS',
      [finding],
      null,
      this.activeTaskChangeContext,
    );
    this.ui.passResult('A', pass.report, pass.changed, pass.revision, pass);
    return this.resolvePassForReview(task, workerA, workerB, pass, routing, {
      nextReviewCycle: incident.reviewCycle + 1,
    });
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

    let evidence = [...initialEvidence];
    let reviewCycle = Math.max(1, Number(startReviewCycle) || 1);
    let reviewCeiling = reviewCycle + Math.max(1, Number(this.maxReviewerCycles) || 3) - 1;
    let reviewerMutationRetries = 0;
    const peerConvergence = usesPeerConvergence(routing);

    try {
      while (true) {
        this.checkCancelled();
        const beforeReview = await this.revisionProvider(this.workspace);
        const beforeState = await this.captureIntegrityState();
        const beforeTrace = toolTraceSnapshot(reviewer.session);
        const beforeUsage = this.getUsageSummary();
        const dossierPrompt = formatReviewDossier(this.activeReviewDossier);
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
            dossierPrompt ? `\n${dossierPrompt}` : '',
            '',
            reviewCycle > 1
              ? 'Re-check unresolved/invalidated earlier review results against the current revision first. Reuse the durable dossier and validation evidence rather than starting discovery from zero. Then inspect only enough additional context to detect regressions or remaining task-level defects.'
              : 'Perform the strong review of this task. Inspect only context relevant to correctness and the acceptance criteria.',
            'Prefer non-mutating validation forms in this read-only role (for example cargo fmt --all -- --check rather than cargo fmt). Do not rerun an exact successful check on the same workspace fingerprint merely for reassurance; rerun only when a concrete concern or changed revision justifies it.',
            'Do not edit files. Call report_review exactly once as soon as you have the verdict.',
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
        const afterState = await this.captureIntegrityState();
        const afterTrace = toolTraceSnapshot(reviewer.session);
        const usage = await this.finishTurn(reviewer, startedAt);
        const durationMs = Date.now() - startedAt;
        const cycleUsage = usageDelta(beforeUsage, usage);
        cycleUsage.durationMs = durationMs;
        const cycleTools = toolTraceDelta(beforeTrace, afterTrace);

        this.activeReviewDossier = appendReviewDossier(this.activeReviewDossier, {
          cycle: reviewCycle,
          revision: afterReview,
          report: review,
          tools: cycleTools,
          usage: cycleUsage,
        });

        if (beforeReview !== afterReview) {
          reviewerMutationRetries += 1;
          const incident = createReviewerMutationIncident({
            taskId: task.id,
            reviewCycle,
            beforeRevision: beforeReview,
            afterRevision: afterReview,
            beforeState,
            afterState,
            beforeTrace,
            afterTrace,
            reviewerReport: review,
          });
          this.activeReviewDossier = appendReviewDossier(this.activeReviewDossier, {
            cycle: reviewCycle,
            revision: afterReview,
            report: review,
            integrityIncident: incident,
          });
          this.ui?.log?.(`Strong reviewer changed workspace in R${reviewCycle}; hard failure replaced by integrity adjudication. before=${beforeReview}; after=${afterReview}`);
          this.ui?.audit?.({ type: 'reviewer_integrity_incident', taskId: task.id, reviewCycle, incident, usage: cycleUsage });

          const syntheticFinding = reviewerMutationFinding(incident);
          await this.saveTaskCheckpoint({
            stage: 'strong_review_findings',
            reviewCycle,
            findings: [syntheticFinding],
            evidence,
            routing,
            integrityIncident: incident,
          });

          if (reviewerMutationRetries > MAX_REVIEWER_MUTATION_RETRIES) {
            pauseWorkflow(
              `Paused after ${reviewerMutationRetries} reviewer workspace-integrity incidents in task ${task.id}; repeated read-only violations require operator inspection before continuing.`,
              { kind: 'reviewer_integrity', task: task.id, reviewCycle, incident },
            );
          }

          const decision = await this.consultReviewerMutationCoordinator(task, incident, routing);
          if (decision.action !== 'retry') {
            pauseWorkflow(
              `Paused because the strong reviewer changed the workspace in R${reviewCycle} and the integrity adjudicator did not authorize automatic worker revalidation.`,
              { kind: 'reviewer_integrity', task: task.id, reviewCycle, incident, decision },
            );
          }

          if (reviewCycle >= reviewCeiling) {
            const additional = await this.requestLimitExtension('reviewer_cycles', reviewCycle, reviewCeiling);
            reviewCeiling = reviewCycle + additional;
            this.ui.phase('Review limit extended', `Continuing strong review for up to ${additional} additional cycle(s), including integrity revalidation.`);
          }

          const resolved = await this.revalidateReviewerMutation(
            task,
            workerA,
            workerB,
            routing,
            incident,
            decision,
          );
          evidence = resolved.evidence;
          await this.saveTaskCheckpoint({
            stage: 'strong_review_pending',
            nextReviewCycle: reviewCycle + 1,
            evidence,
            routing,
          });
          await this.checkAiCreditBudget(`before strong-review cycle ${reviewCycle + 1} after reviewer-integrity revalidation for ${task.id}`);
          reviewCycle += 1;
          continue;
        }

        reviewerMutationRetries = 0;
        this.ui.reviewResult(review, reviewCycle, { durationMs, usage, cycleUsage, tools: cycleTools });

        if (review.verdict === 'clean') return;
        if (review.verdict === 'blocked') {
          const decision = await this.requestReviewerBlockedDecision(task, review, reviewCycle, evidence, routing);
          if (decision.action === 'retry') {
            this.ui.phase('Retrying strong reviewer', `Strong-review cycle ${reviewCycle} will be retried on the same accepted workspace revision with its existing durable review dossier.`);
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
          peerConvergence
            ? `Strong reviewer returned ${review.findings.length} finding(s) in cycle ${reviewCycle}; Worker A remediates, then A/B convergence repeats.`
            : `Strong reviewer returned ${review.findings.length} finding(s) in cycle ${reviewCycle}; Worker A remediates, then the same strong reviewer performs a delta re-check.`,
        );
        const remediation = await this.runWorkerPass(workerA, task, 'FIX_STRONG_REVIEW_FINDINGS', review.findings, null);
        this.ui.passResult('A', remediation.report, remediation.changed, remediation.revision, remediation);
        const resolved = await this.resolvePassForReview(
          task,
          workerA,
          workerB,
          remediation,
          routing,
          { nextReviewCycle: reviewCycle + 1 },
        );
        evidence = resolved.evidence;
        await this.saveTaskCheckpoint({
          stage: 'strong_review_pending',
          nextReviewCycle: reviewCycle + 1,
          evidence,
          routing,
        });
        await this.checkAiCreditBudget(`before strong-review cycle ${reviewCycle + 1} for ${task.id}`);
        reviewCycle += 1;
      }
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
  taskWithArchitectureAssessment,
  reviewerMutationFinding,
  MAX_REVIEWER_MUTATION_RETRIES,
};