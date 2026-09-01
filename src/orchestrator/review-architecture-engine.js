'use strict';

const { StableChatRecoveryEngine } = require('./stable-chat-recovery');
const { ReviewArchitectureSessionFactory } = require('../copilot/review-architecture-session-factory');
const {
  DEFAULT_REVIEW_ARCHITECTURE,
  normalizeReviewArchitecture,
} = require('./review-architecture');
const {
  requireReport,
  taskPrompt,
  formatValidationEvidence,
  reconcileDeterministicIntegrity,
} = require('./engine');
const { formatTaskChangeManifest } = require('./task-change-manifest');
const { usesPeerConvergence } = require('./routing');
const { pauseWorkflow } = require('./control');
const { queueRecoveryInstruction } = require('./recovery-engine');
const {
  normalizeUsageSnapshot,
  mergeUsageSnapshots,
  usageDelta,
} = require('./usage-ledger');
const {
  normalizeReviewDossier,
  appendReviewDossier,
  formatReviewDossier,
} = require('./review-dossier');
const {
  toolTraceSnapshot,
  reviewerTraceSnapshot,
  toolTraceDelta,
  createReviewerMutationIncident,
  formatReviewerMutationIncident,
} = require('./reviewer-integrity');

const MAX_REVIEWER_MUTATION_INCIDENTS = 2;

function configuredReviewArchitecture(options = {}) {
  if (options.reviewArchitecture) return options.reviewArchitecture;
  try {
    return globalThis.__convergentReviewArchitectureProvider?.() ?? DEFAULT_REVIEW_ARCHITECTURE;
  } catch {
    return DEFAULT_REVIEW_ARCHITECTURE;
  }
}

class ReviewerWorkspaceMutationError extends Error {
  constructor(incident, reviewerReport = null) {
    super(`Read-only reviewer changed the workspace during review cycle ${incident?.reviewCycle ?? '?'}.`);
    this.name = 'ReviewerWorkspaceMutationError';
    this.code = 'CONVERGENT_REVIEWER_WORKSPACE_MUTATION';
    this.incident = incident;
    this.reviewerReport = reviewerReport;
  }
}

function isReviewerWorkspaceMutationError(error) {
  return error?.code === 'CONVERGENT_REVIEWER_WORKSPACE_MUTATION';
}

function reviewerMutationFinding(incident, decision = {}) {
  const paths = (incident?.changedPaths ?? []).map((entry) => entry.path).filter(Boolean);
  return {
    severity: 'high',
    title: 'Revalidate reviewer-modified workspace',
    description: [
      `The read-only review gate changed the workspace during review cycle ${incident?.reviewCycle ?? '?'}.`,
      incident?.reviewerLabel ? `Detected at reviewer: ${incident.reviewerLabel}.` : '',
      paths.length ? `Changed path(s): ${paths.join(', ')}.` : '',
      'Do not accept or reject the change merely because it came from a reviewer or because a strong coordinator can explain it. Independently inspect the current revision, keep/rework/revert the change as technically appropriate, and validate the task before returning it to a fresh review gate.',
      decision.guidance ? `Recovery guidance: ${decision.guidance}` : '',
    ].filter(Boolean).join(' '),
  };
}

class ReviewArchitectureEngine extends StableChatRecoveryEngine {
  constructor(options = {}) {
    const initial = normalizeReviewArchitecture(configuredReviewArchitecture(options));
    let checkpointArchitecture = initial.id;
    const originalOnCheckpoint = options.onCheckpoint;
    super({
      ...options,
      onCheckpoint: typeof originalOnCheckpoint === 'function'
        ? (state) => originalOnCheckpoint({ ...state, reviewArchitecture: checkpointArchitecture })
        : originalOnCheckpoint,
    });
    this.reviewArchitecture = initial;
    this.restoredUsageLedger = normalizeUsageSnapshot(null);
    this.activeReviewDossier = normalizeReviewDossier(null);
    this._setCheckpointReviewArchitecture = (value) => {
      checkpointArchitecture = normalizeReviewArchitecture(value).id;
    };

    const persistCheckpoint = this.onCheckpoint;
    this.onCheckpoint = async (state) => persistCheckpoint({
      ...state,
      usageLedger: normalizeUsageSnapshot(this.getUsageSummary()),
    });
  }

  getUsageSummary() {
    return mergeUsageSnapshots(this.restoredUsageLedger, this.usage?.summary?.() ?? {});
  }

  sessionFactory() {
    const factory = super.sessionFactory();
    // The base factory has already established all command/runtime/credential
    // state. The 0.5 subclass only changes reviewer construction.
    Object.setPrototypeOf(factory, ReviewArchitectureSessionFactory.prototype);
    factory.reviewArchitecture = this.reviewArchitecture.id;
    return factory;
  }

  async saveTaskCheckpoint(taskState) {
    const requested = taskState?.reviewDossier;
    if (requested) this.activeReviewDossier = normalizeReviewDossier(requested);
    const dossier = normalizeReviewDossier(this.activeReviewDossier);
    return super.saveTaskCheckpoint({
      ...taskState,
      ...(dossier.cycles.length ? { reviewDossier: dossier } : {}),
    });
  }

  async runTask(factory, task, taskSessionKey, routing, taskResumeState = null) {
    const previous = this.activeReviewDossier;
    this.activeReviewDossier = normalizeReviewDossier(taskResumeState?.reviewDossier);
    try {
      // A reviewer-integrity checkpoint is written before semantic adjudication
      // and worker revalidation. If execution stops at that boundary, an
      // unchanged /resume must not silently reinterpret it as ordinary review
      // findings and proceed. A changed workspace is already handled by the
      // resumable engine's fingerprint fallback before this method is reached.
      if (taskResumeState?.stage === 'strong_review_findings' && taskResumeState?.integrityIncident) {
        pauseWorkflow(
          `Task ${task.id} is paused at a reviewer-integrity boundary. The saved workspace still matches the reviewer-modified fingerprint, so Convergent will not continue from ordinary remediation semantics. Change/resolve the workspace prerequisite or start the task from a changed state before continuing.`,
          {
            kind: 'reviewer_integrity_resume_guard',
            task: task.id,
            reviewCycle: taskResumeState.reviewCycle,
            integrityIncident: taskResumeState.integrityIncident,
          },
        );
      }
      return await super.runTask(factory, task, taskSessionKey, routing, taskResumeState);
    } finally {
      this.activeReviewDossier = previous;
    }
  }

  async captureReviewerIntegrityState() {
    try {
      return await this.changeStateProvider(this.workspace, null, this.workspaceFolders);
    } catch (error) {
      this.ui?.log?.(`Reviewer-integrity change-state capture unavailable: ${error?.message ?? String(error)}`);
      return null;
    }
  }

  async installReviewerMutationGuards(reviewer, task, reviewCycle, expectedRevision, expectedState) {
    const agents = Array.isArray(reviewer?.members) && reviewer.members.length
      ? reviewer.members
      : [reviewer];
    const restores = [];

    for (const agent of agents) {
      const session = agent?.session;
      if (!session || typeof session.sendAndWait !== 'function') continue;
      const original = session.sendAndWait.bind(session);
      const reviewerId = agent?.reviewSpec?.id ?? reviewer?.reviewSpec?.id ?? reviewer?.architecture?.id ?? 'reviewer';
      const reviewerLabel = agent?.label ?? agent?.name ?? reviewer?.name ?? 'Strong reviewer';
      toolTraceSnapshot(session, reviewerLabel);

      session.sendAndWait = async (options, timeoutMs) => {
        const beforeRevision = await this.revisionProvider(this.workspace, this.workspaceFolders);
        const beforeState = await this.captureReviewerIntegrityState();
        const beforeTrace = toolTraceSnapshot(session, reviewerLabel);

        if (expectedRevision && beforeRevision !== expectedRevision) {
          const incident = createReviewerMutationIncident({
            taskId: task.id,
            reviewCycle,
            reviewerId: 'inter-review-boundary',
            reviewerLabel: `Before ${reviewerLabel}`,
            beforeRevision: expectedRevision,
            afterRevision: beforeRevision,
            beforeState: expectedState,
            afterState: beforeState,
            beforeTrace,
            afterTrace: beforeTrace,
            reviewerReport: null,
          });
          throw new ReviewerWorkspaceMutationError(incident, null);
        }

        const startedAt = Date.now();
        const result = await original(options, timeoutMs);
        const afterRevision = await this.revisionProvider(this.workspace, this.workspaceFolders);
        if (afterRevision === beforeRevision) return result;

        const afterState = await this.captureReviewerIntegrityState();
        const afterTrace = toolTraceSnapshot(session, reviewerLabel);
        const reviewerReport = agent?.sink?.value ?? reviewer?.sink?.value ?? null;

        // The normal composite/single-review path records the turn only after a
        // successful send. This path exits early, so account for the violating
        // reviewer turn before raising the integrity incident.
        if (agent?.usageName) {
          this.usage.recordTurn(agent.usageName, Date.now() - startedAt);
          await this.usage.refresh(agent.usageName, session);
        }

        const incident = createReviewerMutationIncident({
          taskId: task.id,
          reviewCycle,
          reviewerId,
          reviewerLabel,
          beforeRevision,
          afterRevision,
          beforeState,
          afterState,
          beforeTrace,
          afterTrace,
          reviewerReport,
        });

        // requireReport/sendMemberReview deliberately tolerate a send error when
        // a structured report already exists. Clear the partial sink so the
        // mutation exception remains authoritative and, for R2/R3, prevents the
        // composite reviewer from advancing to the next panel member.
        if (agent?.sink) agent.sink.value = null;
        if (reviewer?.sink && reviewer !== agent) reviewer.sink.value = null;
        throw new ReviewerWorkspaceMutationError(incident, reviewerReport);
      };

      restores.push(() => {
        session.sendAndWait = original;
      });
    }

    return () => restores.reverse().forEach((restore) => restore());
  }

  async classifyReviewerMutation(task, incident, routing) {
    this.ui?.phase?.(
      'Reviewer integrity assessment',
      `The read-only review gate changed the workspace in cycle ${incident.reviewCycle}. A strong recovery coordinator is classifying the incident before any continuation.`,
    );
    const decision = await this.consultRecoveryCoordinator(task, `reviewer-integrity-r${incident.reviewCycle}`, {
      workspaceFingerprint: incident.afterRevision,
      summary: [
        `${incident.reviewerLabel || 'A reviewer'} changed the workspace during a read-only review pass.`,
        'A retry decision authorizes only independent implementation-worker revalidation; it never approves the reviewer-created revision.',
      ].join(' '),
      findings: [formatReviewerMutationIncident(incident)],
      checks: incident.reviewerReport?.checks ?? [],
      reviewArchitecture: this.reviewArchitecture.id,
      route: routing.route,
      risk: routing.risk,
    }, { allowPeer: false });
    this.ui?.audit?.({
      type: 'reviewer_integrity_decision',
      taskId: task.id,
      reviewCycle: incident.reviewCycle,
      incident,
      decision,
    });
    return decision;
  }

  async replaceReviewerAfterIntegrity(reviewer, task, mutationCount, routing) {
    const context = this.activeRuntimeRecoveryContext;
    if (!context?.factory || !context.taskSessionKey) {
      pauseWorkflow(
        `Paused because Convergent cannot create a fresh review gate after the reviewer-integrity incident on task ${task.id}.`,
        { kind: 'reviewer_integrity_missing_context', task: task.id },
      );
    }

    await this.disposeRuntimeStalledAgent(reviewer);
    const replacement = await context.factory.createReviewer(
      context.taskSessionKey,
      routing.route,
      routing.risk,
      `integrity-retry-${mutationCount}`,
    );
    this.sessions.push(replacement.session);
    Object.assign(reviewer, replacement);
    this.ui?.log?.(`Replaced the review gate with fresh session(s) after reviewer-integrity incident ${mutationCount} on task ${task.id}.`);
    this.ui?.audit?.({
      type: 'reviewer_integrity_reviewer_replaced',
      taskId: task.id,
      mutationCount,
      replacementSessionId: replacement.session?.sessionId,
      architecture: replacement.architecture?.id ?? this.reviewArchitecture.id,
    });
  }

  async revalidateReviewerMutation(task, workerA, workerB, routing, incident, decision) {
    const finding = reviewerMutationFinding(incident, decision);
    queueRecoveryInstruction(workerA?.session, [
      decision.guidance || decision.rationale,
      'This is an independent revalidation of workspace state changed during a read-only review. Do not preserve the change merely because a reviewer produced it; inspect it as untrusted candidate implementation state.',
    ].filter(Boolean).join('\n'));

    this.ui?.phase?.(
      'Reviewer-change revalidation',
      usesPeerConvergence(routing)
        ? 'Worker A will independently inspect the reviewer-modified revision, then A/B convergence must approve the resulting fingerprint before a fresh review gate runs.'
        : 'Worker A will independently inspect the reviewer-modified revision before a fresh review gate runs.',
    );

    const pass = await this.runWorkerPass(
      workerA,
      task,
      'FIX_STRONG_REVIEW_FINDINGS',
      [finding],
      null,
    );
    this.ui.passResult('A', pass.report, pass.changed, pass.revision, pass);
    return this.resolvePassForReview(task, workerA, workerB, pass, routing, {
      nextReviewCycle: incident.reviewCycle + 1,
    });
  }

  async processReviewerMutation({
    task,
    workerA,
    workerB,
    reviewer,
    routing,
    reviewCycle,
    reviewCeiling,
    mutationCount,
    evidence,
    mutationError,
    beforeUsage,
    beforeTrace,
  }) {
    mutationCount += 1;
    const incident = mutationError.incident;
    const afterUsage = this.getUsageSummary();
    const cycleUsage = usageDelta(beforeUsage, afterUsage);
    const cycleTools = toolTraceDelta(beforeTrace, reviewerTraceSnapshot(reviewer));
    const invalidReport = mutationError.reviewerReport ?? {
      verdict: 'blocked',
      findings: [],
      checks: [],
      summary: 'Review pass invalidated because the read-only review gate did not observe one stable workspace fingerprint.',
    };

    this.activeReviewDossier = appendReviewDossier(this.activeReviewDossier, {
      cycle: reviewCycle,
      revision: incident.afterRevision,
      report: invalidReport,
      tools: cycleTools,
      usage: cycleUsage,
      integrityIncident: incident,
    });
    this.ui?.log?.(`Reviewer workspace-integrity incident in cycle ${reviewCycle}: ${incident.reviewerLabel || 'review gate'} changed/observed ${incident.beforeRevision} -> ${incident.afterRevision}.`);
    this.ui?.audit?.({
      type: 'reviewer_integrity_incident',
      taskId: task.id,
      reviewCycle,
      incident,
      usage: cycleUsage,
      tools: cycleTools,
    });

    const finding = reviewerMutationFinding(incident);
    await this.saveTaskCheckpoint({
      stage: 'strong_review_findings',
      reviewCycle,
      findings: [finding],
      evidence,
      routing,
      integrityIncident: incident,
    });

    if (mutationCount > MAX_REVIEWER_MUTATION_INCIDENTS) {
      pauseWorkflow(
        `Paused after ${mutationCount} reviewer workspace-integrity incidents on task ${task.id}. Repeated read-only violations require operator inspection.`,
        { kind: 'reviewer_integrity_retry_limit', task: task.id, reviewCycle, incident },
      );
    }

    const decision = await this.classifyReviewerMutation(task, incident, routing);
    if (decision.action !== 'retry') {
      pauseWorkflow(
        `Paused because the review gate changed the workspace in cycle ${reviewCycle} and the recovery coordinator did not authorize independent worker revalidation.`,
        { kind: 'reviewer_integrity', task: task.id, reviewCycle, incident, decision },
      );
    }

    if (reviewCycle >= reviewCeiling) {
      const additional = await this.requestLimitExtension('reviewer_cycles', reviewCycle, reviewCeiling);
      reviewCeiling = reviewCycle + additional;
      this.ui.phase('Review limit extended', `Continuing for up to ${additional} additional cycle(s), including reviewer-integrity revalidation.`);
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
    await this.replaceReviewerAfterIntegrity(reviewer, task, mutationCount, routing);
    await this.saveTaskCheckpoint({
      stage: 'strong_review_pending',
      nextReviewCycle: reviewCycle + 1,
      evidence,
      routing,
    });
    await this.checkAiCreditBudget(`before strong-review cycle ${reviewCycle + 1} after reviewer-integrity revalidation for ${task.id}`);
    return { evidence, reviewCeiling, mutationCount };
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
    this.applyStrongReviewAgreement(task, reviewer);
    this.activeReviewerForRecovery = reviewer;
    let evidence = [...initialEvidence];
    let reviewCycle = Math.max(1, Number(startReviewCycle) || 1);
    let reviewCeiling = reviewCycle + Math.max(1, Number(this.maxReviewerCycles) || 3) - 1;
    let mutationCount = normalizeReviewDossier(this.activeReviewDossier).cycles
      .filter((cycle) => Boolean(cycle.integrityIncident)).length;
    const peerConvergence = usesPeerConvergence(routing);

    try {
      while (true) {
        this.checkCancelled();
        const beforeReview = await this.revisionProvider(this.workspace, this.workspaceFolders);
        const beforeState = await this.captureReviewerIntegrityState();
        const beforeTrace = reviewerTraceSnapshot(reviewer);
        const beforeUsage = this.getUsageSummary();
        const changeManifest = await this.currentTaskChangeManifest(this.activeTaskChangeContext);
        const dossierPrompt = formatReviewDossier(this.activeReviewDossier);
        const prompt = [
          taskPrompt(task),
          '',
          peerConvergence
            ? `Worker A and Worker B approved current revision ${beforeReview.slice(0, 12)}.`
            : `Worker A produced current revision ${beforeReview.slice(0, 12)}; you are the independent acceptance gate for this standard task.`,
          `Task workflow: ${routing.route}; task risk: ${routing.risk}.`,
          `Review architecture: ${this.reviewArchitecture.benchmarkId} ${this.reviewArchitecture.label}.`,
          formatValidationEvidence(evidence),
          changeManifest ? `\n${formatTaskChangeManifest(changeManifest, 'Deterministic task change manifest for this review')}` : '',
          dossierPrompt ? `\n${dossierPrompt}` : '',
          '',
          reviewCycle > 1
            ? 'Re-check unresolved or invalidated earlier results against the current revision first. Reuse the durable dossier and exact-revision validation evidence instead of restarting discovery from zero. Then inspect only enough additional context to detect regressions or remaining task-level defects.'
            : 'Perform the strong review of this task. Inspect only context relevant to correctness and the acceptance criteria.',
          'Start with exact task-change paths when available. Prefer non-mutating validation forms in this read-only role (for example cargo fmt --all -- --check). Do not rerun an exact successful check on the same workspace fingerprint merely for reassurance; rerun it only when a concrete concern or changed revision justifies it.',
          'Do not edit files. Call report_review exactly once as soon as you have the verdict.',
        ].filter(Boolean).join('\n');

        const startedAt = Date.now();
        let restoreGuards = () => {};
        let review;
        let mutationError = null;
        try {
          restoreGuards = await this.installReviewerMutationGuards(
            reviewer,
            task,
            reviewCycle,
            beforeReview,
            beforeState,
          );
          review = await requireReport(
            reviewer.session,
            reviewer.sink,
            prompt,
            'report_review',
            this.agentTurnTimeoutMs,
          );
        } catch (error) {
          if (isReviewerWorkspaceMutationError(error)) {
            mutationError = error;
          } else {
            const outcome = await this.recoverRuntimeStallAgent(error, reviewer, task, 'reviewer');
            if (outcome?.retry) continue;
            throw error;
          }
        } finally {
          restoreGuards();
        }

        let durationMs = Date.now() - startedAt;
        let usage = null;
        let cycleUsage = null;
        let cycleTools = null;

        if (!mutationError) {
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

          const afterReview = await this.revisionProvider(this.workspace, this.workspaceFolders);
          const afterState = await this.captureReviewerIntegrityState();
          usage = await this.finishTurn(reviewer, startedAt);
          durationMs = Date.now() - startedAt;
          cycleUsage = usageDelta(beforeUsage, usage);
          const afterTrace = reviewerTraceSnapshot(reviewer);
          cycleTools = toolTraceDelta(beforeTrace, afterTrace);

          if (beforeReview !== afterReview) {
            const incident = createReviewerMutationIncident({
              taskId: task.id,
              reviewCycle,
              reviewerId: 'review-gate-boundary',
              reviewerLabel: `${this.reviewArchitecture.benchmarkId} review gate boundary`,
              beforeRevision: beforeReview,
              afterRevision: afterReview,
              beforeState,
              afterState,
              beforeTrace,
              afterTrace,
              reviewerReport: review,
            });
            if (reviewer?.sink) reviewer.sink.value = null;
            mutationError = new ReviewerWorkspaceMutationError(incident, review);
          }
        }

        if (mutationError) {
          const processed = await this.processReviewerMutation({
            task,
            workerA,
            workerB,
            reviewer,
            routing,
            reviewCycle,
            reviewCeiling,
            mutationCount,
            evidence,
            mutationError,
            beforeUsage,
            beforeTrace,
          });
          evidence = processed.evidence;
          reviewCeiling = processed.reviewCeiling;
          mutationCount = processed.mutationCount;
          reviewCycle += 1;
          continue;
        }

        this.activeReviewDossier = appendReviewDossier(this.activeReviewDossier, {
          cycle: reviewCycle,
          revision: await this.revisionProvider(this.workspace, this.workspaceFolders),
          report: review,
          tools: cycleTools,
          usage: cycleUsage,
        });
        this.ui.reviewResult(review, reviewCycle, { durationMs, usage, cycleUsage, tools: cycleTools });
        this.ui?.log?.(`Review cycle ${reviewCycle} usage: ${cycleUsage.inputTokens} input / ${cycleUsage.outputTokens} output / ${cycleUsage.reasoningTokens} reasoning tokens; ${cycleUsage.aiCredits.toFixed(3)} AI credits; ${cycleTools.length} completed reviewer tool call(s).`);

        if (review.verdict === 'clean') return;
        if (review.verdict === 'blocked') {
          const decision = await this.requestReviewerBlockedDecision(task, review, reviewCycle, evidence, routing);
          if (decision.action === 'retry') {
            this.ui.phase('Retrying strong reviewer', `Strong-review cycle ${reviewCycle} will be retried on the same accepted workspace revision with its durable review dossier.`);
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
            : `Strong reviewer returned ${review.findings.length} finding(s) in cycle ${reviewCycle}; Worker A remediates, then the same review architecture performs a delta re-check.`,
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
      if (this.activeReviewerForRecovery === reviewer) this.activeReviewerForRecovery = null;
    }
  }

  async run(userRequest, resumeState = null) {
    this.restoredUsageLedger = normalizeUsageSnapshot(resumeState?.usageLedger);
    const saved = resumeState?.reviewArchitecture;
    if (saved) {
      const resumed = normalizeReviewArchitecture(saved);
      if (resumed.id !== this.reviewArchitecture.id) {
        this.ui?.log?.(`Resume keeps saved review architecture ${resumed.benchmarkId} ${resumed.label}; current workspace setting ${this.reviewArchitecture.id} applies only to new workflows.`);
      }
      this.reviewArchitecture = resumed;
    }
    this._setCheckpointReviewArchitecture(this.reviewArchitecture.id);
    if (this.restoredUsageLedger.agents.length || this.restoredUsageLedger.totalNanoAiu || this.restoredUsageLedger.inputTokens || this.restoredUsageLedger.outputTokens) {
      const restored = this.getUsageSummary();
      this.ui?.log?.(`Restored request-lifetime usage before resume: ${restored.inputTokens} input / ${restored.outputTokens} output tokens; ${restored.aiCredits.toFixed(3)} AI credits.`);
      this.ui?.audit?.({ type: 'usage_ledger_restored', usage: this.restoredUsageLedger });
    }
    this.ui?.log?.(`Review architecture: ${this.reviewArchitecture.benchmarkId} ${this.reviewArchitecture.label} (${this.reviewArchitecture.id}) — ${this.reviewArchitecture.description}`);
    try {
      void this.ui?.auditEvent?.({
        type: 'review_architecture_selected',
        id: this.reviewArchitecture.id,
        benchmarkId: this.reviewArchitecture.benchmarkId,
        label: this.reviewArchitecture.label,
        reviewerCount: this.reviewArchitecture.reviewerCount,
        modelFamily: this.reviewArchitecture.modelFamily,
        specialized: this.reviewArchitecture.specialized,
      });
    } catch {}
    return super.run(userRequest, resumeState);
  }
}

module.exports = {
  ReviewArchitectureEngine,
  configuredReviewArchitecture,
  ReviewerWorkspaceMutationError,
  isReviewerWorkspaceMutationError,
  reviewerMutationFinding,
  MAX_REVIEWER_MUTATION_INCIDENTS,
};