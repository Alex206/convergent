'use strict';

const { BenchmarkTopologyEngine, LeanStandardSessionFactory } = require('./topology-engine');
const { requireReport } = require('../orchestrator/engine');
const { queueRecoveryInstruction } = require('../orchestrator/recovery-engine');
const { resolveWorkerModel } = require('../orchestrator/model-resolver');
const { chooseReasoningEffort } = require('../orchestrator/routing');
const {
  attachEventLogging,
  safeSessionPart,
  withReasoning,
} = require('../copilot/session-factory');

const REVIEW_AUDIT_TOOL = 'custom:report_review_audit';
const DEFAULT_MAX_REVIEW_AUDIT_ROUNDS = 3;

const REVIEW_EVIDENCE_AUDITOR_PROMPT = `
You are a tiny semantic quality gate for another model's code-review report.

You do NOT review the code and you have no repository access. Judge only whether the strong review report itself contains adequate evidence for the stated high-risk review contract. Never infer that a check happened unless the report explicitly records it.

For a high-risk transformation at a trust/security boundary, a CLEAN review is adequate only when its own reported evidence demonstrates all of these aspects:
1. The relevant trust/security boundary or invariant is identified concretely.
2. A composed/transitional sequence is considered, not only the final normalized/canonical state in isolation.
3. At least one hostile composition is actually exercised where an intermediate step crosses/rebinds the boundary and a later step can make the final representation appear acceptable; the concrete input and observed result are recorded.
4. At least one benign composition is actually exercised and shown to remain accepted. It must be a matched counterpart to the hostile witness: it stresses the same semantic transition/normalization topology and the same controversial kind of intermediate state, except that the security-relevant boundary condition remains permitted.
5. The report explicitly explains why the hostile and benign witnesses form a matched contrast and identifies the security-relevant property that differs between them.
6. The benign witness is an over-restriction guard: it would fail if the remediation merely rejected the whole transition family or every intermediate excursion instead of enforcing the actual boundary invariant.
7. The hostile and benign witnesses are discriminating performed evidence with concrete observed outcomes, not generic claims such as "symlink tested", "normalization works", "edge cases covered", or restatements of the implementation.

A benign witness is NOT adequate merely because it belongs to the same broad feature family. If the hostile witness depends on a controversial intermediate transition followed by a later normalization/re-entry, a benign witness that never exercises the corresponding permitted transition cannot prove that the remediation preserved valid behavior. The pair must be close enough that an over-restrictive implementation would be exposed by the benign member.

Do not demand any particular hidden test case, path spelling, platform, or implementation. A different concrete witness pair is valid if it proves the same semantic properties. FINDINGS/BLOCKED reports do not need to prove CLEAN; this auditor is used only after the strong reviewer has returned CLEAN.

Mark each required aspect true only when the report explicitly supports it. Call report_review_audit exactly once. Keep missing_or_weak_aspects concise and actionable for the strong reviewer.
`.trim();

const REVIEW_AUDIT_ASPECTS = Object.freeze([
  ['boundary_identified', 'identify the concrete trust/security boundary or invariant'],
  ['transition_sequence_tested', 'exercise a composed/transitional sequence rather than only judging the final representation'],
  ['hostile_composition_observed', 'exercise and record a concrete hostile intermediate boundary-crossing/rebinding composition and its observed result'],
  ['benign_composition_observed', 'exercise and record a benign matched counterpart that stresses the corresponding permitted transition/normalization topology'],
  ['matched_contrast_pair', 'show that hostile and benign witnesses are a matched contrast and identify the security-relevant property that differs'],
  ['overrestriction_guard', 'show that the benign witness would falsify an over-restrictive remediation that rejects the whole transition family or every intermediate excursion'],
  ['discriminating_evidence', 'show concrete performed hostile/benign observations that discriminate the invariant rather than generic coverage or implementation restatement'],
]);

const TRUST_BOUNDARY_REVIEW_AUDIT_CONTRACT = Object.freeze({
  id: 'trust-boundary-composition-v1',
  prompt: REVIEW_EVIDENCE_AUDITOR_PROMPT,
  aspects: REVIEW_AUDIT_ASPECTS,
  toolDescription: 'Semantically assess whether a strong CLEAN review report explicitly demonstrates every required high-risk evidence aspect. This tool does not review code.',
  feedbackInstructions: Object.freeze([
    'For a hostile/benign contrast, the benign witness must be a matched semantic counterpart and must be capable of falsifying an over-restrictive implementation. Merely showing that some ordinary normalization or some unrelated valid case works is insufficient.',
    'State explicitly what security-relevant property differs between the pair and why both witnesses stress the same controversial transition shape.',
  ]),
});

function normalizeAuditContract(contract = TRUST_BOUNDARY_REVIEW_AUDIT_CONTRACT) {
  const source = contract ?? TRUST_BOUNDARY_REVIEW_AUDIT_CONTRACT;
  const id = String(source.id ?? '').trim();
  const prompt = String(source.prompt ?? '').trim();
  const rawAspects = Array.isArray(source.aspects) ? source.aspects : [];
  const aspects = rawAspects.map((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) throw new Error(`Review audit contract ${id || '<unnamed>'} has an invalid aspect.`);
    const key = String(entry[0] ?? '').trim();
    const description = String(entry[1] ?? '').trim();
    if (!/^[a-z][a-z0-9_]*$/.test(key) || !description) {
      throw new Error(`Review audit contract ${id || '<unnamed>'} has an invalid aspect.`);
    }
    return [key, description];
  });
  if (!id) throw new Error('Review audit contract requires a stable id.');
  if (!prompt) throw new Error(`Review audit contract ${id} requires prompt.`);
  if (!aspects.length) throw new Error(`Review audit contract ${id} requires at least one aspect.`);
  if (new Set(aspects.map(([key]) => key)).size !== aspects.length) {
    throw new Error(`Review audit contract ${id} has duplicate aspect keys.`);
  }
  return Object.freeze({
    id,
    prompt,
    aspects: Object.freeze(aspects.map((entry) => Object.freeze(entry))),
    toolDescription: String(source.toolDescription ?? 'Assess whether the strong CLEAN review report explicitly demonstrates every required evidence aspect.').trim(),
    feedbackInstructions: Object.freeze(
      (Array.isArray(source.feedbackInstructions) ? source.feedbackInstructions : [])
        .map((item) => String(item ?? '').trim())
        .filter(Boolean),
    ),
  });
}

function normalizeAuditReport(args = {}, contract = TRUST_BOUNDARY_REVIEW_AUDIT_CONTRACT) {
  const normalizedContract = normalizeAuditContract(contract);
  const aspects = Object.fromEntries(normalizedContract.aspects.map(([key]) => [key, args[key] === true]));
  const missing = Array.isArray(args.missing_or_weak_aspects)
    ? args.missing_or_weak_aspects.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
  const adequate = normalizedContract.aspects.every(([key]) => aspects[key] === true);
  return {
    adequate,
    audit_contract: normalizedContract.id,
    ...aspects,
    summary: String(args.summary ?? '').trim(),
    missing_or_weak_aspects: missing,
  };
}

function validateAuditReport(report) {
  if (!report.summary) return 'Audit summary is required.';
  if (!report.adequate && report.missing_or_weak_aspects.length === 0) {
    return 'An inadequate review audit requires at least one missing_or_weak_aspects entry.';
  }
  if (report.adequate && report.missing_or_weak_aspects.length > 0) {
    return 'An adequate review audit requires missing_or_weak_aspects=[].';
  }
  return null;
}

function createReviewAuditTool(defineTool, sink, contract = TRUST_BOUNDARY_REVIEW_AUDIT_CONTRACT) {
  const normalizedContract = normalizeAuditContract(contract);
  const booleanProperties = Object.fromEntries(normalizedContract.aspects.map(([key]) => [key, { type: 'boolean' }]));
  return defineTool('report_review_audit', {
    description: normalizedContract.toolDescription,
    parameters: {
      type: 'object',
      properties: {
        ...booleanProperties,
        summary: { type: 'string' },
        missing_or_weak_aspects: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: [
        ...normalizedContract.aspects.map(([key]) => key),
        'summary',
        'missing_or_weak_aspects',
      ],
      additionalProperties: false,
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args) => {
      const report = normalizeAuditReport(args, normalizedContract);
      const error = validateAuditReport(report);
      if (error) return { accepted: false, error, retry: true };
      sink.value = report;
      return { accepted: true, adequate: report.adequate };
    },
  });
}

function compactTaskForAudit(task) {
  return {
    title: String(task?.title ?? '').trim(),
    description: String(task?.description ?? '').trim().slice(0, 1800),
    acceptanceCriteria: (Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria : [])
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .slice(0, 12),
  };
}

function auditPrompt(task, review) {
  return [
    'TASK CONTRACT (bounded; no repository content):',
    JSON.stringify(compactTaskForAudit(task), null, 2),
    '',
    'STRONG REVIEWER FINAL STRUCTURED REPORT:',
    JSON.stringify({
      verdict: review?.verdict ?? null,
      summary: review?.summary ?? '',
      findings: review?.findings ?? [],
      checks: review?.checks ?? [],
    }, null, 2),
    '',
    'Assess only whether this report explicitly demonstrates every required evidence aspect. Do not infer unreported work and do not review the implementation.',
  ].join('\n');
}

function auditFeedback(report, contract = TRUST_BOUNDARY_REVIEW_AUDIT_CONTRACT) {
  const normalizedContract = normalizeAuditContract(contract);
  const missing = report?.missing_or_weak_aspects?.length
    ? report.missing_or_weak_aspects
    : normalizedContract.aspects
      .filter(([key]) => report?.[key] !== true)
      .map(([, description]) => description);
  return [
    'The low-context semantic evidence auditor rejected your CLEAN review report as insufficiently demonstrated. This is a review-quality retry, not evidence that the implementation is defective.',
    'Perform only the missing discriminating validation needed to close these evidence gaps, then submit a new report_review. Put concrete performed witness inputs and observed outcomes in checks; if that validation exposes a real code defect, return FINDINGS normally.',
    ...normalizedContract.feedbackInstructions,
    ...missing.map((item) => `- ${item}`),
    'Your next CLEAN report must itself contain enough explicit evidence for an independent auditor with no repository access to verify these aspects.',
  ].join('\n');
}

class ReviewEvidenceAuditorSessionFactory extends LeanStandardSessionFactory {
  constructor(options = {}) {
    super({ ...options, benchmarkToolProfile: 'structured' });
    this.reviewAuditorSelector = String(options.reviewAuditorSelector ?? 'gpt-5.6-luna').trim();
    this.reviewAuditContract = normalizeAuditContract(options.reviewAuditContract ?? TRUST_BOUNDARY_REVIEW_AUDIT_CONTRACT);
  }

  async createReviewEvidenceAuditor(taskId, route = 'high_risk', risk = 'high', sessionAttempt = '') {
    const safeTaskId = safeSessionPart(taskId);
    const attemptSuffix = sessionAttempt ? `-${safeSessionPart(sessionAttempt)}` : '';
    const sink = { value: null };
    const tool = createReviewAuditTool(this.sdk.defineTool, sink, this.reviewAuditContract);
    const model = resolveWorkerModel(
      this.reviewAuditorSelector,
      this.models.available ?? [],
      { worker: 'B', route, risk, flowMode: this.flowMode },
    );
    const effort = chooseReasoningEffort(model, 'low', this.reasoningMode);
    const name = 'Review evidence auditor';
    const availableTools = [REVIEW_AUDIT_TOOL];
    const systemPrompt = this.reviewAuditContract.prompt;

    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-review-evidence-auditor${attemptSuffix}`,
      clientName: 'convergent-headless-review-auditor-benchmark',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [tool],
      availableTools,
      systemMessage: { mode: 'append', content: systemPrompt },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));

    const guard = this.guard(session, name);
    const usageKey = `${safeTaskId}:review-evidence-auditor${attemptSuffix}`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey, {
      sink,
      toolName: 'report_review_audit',
    });
    this.ui.agentTools?.(name, availableTools);
    this.sessionCreated(name, session, model, effort, systemPrompt, availableTools, {
      role: 'review-evidence-auditor',
      taskId: safeTaskId,
      route,
      risk,
      sessionAttempt: sessionAttempt || null,
      reviewAuditContract: this.reviewAuditContract.id,
      benchmarkOnly: true,
      lowContext: true,
      repositoryTools: false,
    });
    return { session, guard, sink, name, usageName: usageKey, model, reasoningEffort: effort };
  }
}

class ReviewEvidenceAuditorBenchmarkEngine extends BenchmarkTopologyEngine {
  constructor(options = {}) {
    super({ ...options, topology: 'luna-terra-structured' });
    this.experimentTopology = String(options.experimentTopology ?? 'review-audit').trim();
    this.reviewAuditorSelector = String(options.reviewAuditorSelector ?? 'gpt-5.6-luna').trim();
    this.reviewAuditContract = normalizeAuditContract(options.reviewAuditContract ?? TRUST_BOUNDARY_REVIEW_AUDIT_CONTRACT);
    this.maxReviewAuditRounds = Math.max(
      1,
      Number(options.maxReviewAuditRounds) || DEFAULT_MAX_REVIEW_AUDIT_ROUNDS,
    );
  }

  sessionFactory() {
    return new ReviewEvidenceAuditorSessionFactory({
      client: this.client,
      sdk: this.sdk,
      workspace: this.workspace,
      workspaceFolders: this.workspaceFolders,
      models: this.models,
      permissionHandler: this.permissionHandler,
      userInputHandler: this.userInputHandler,
      ui: this.ui,
      usage: this.usage,
      runId: this.runId,
      reasoningMode: this.reasoningMode,
      operatorCredentialGuard: this.operatorCredentialGuard,
      reviewAuditorSelector: this.reviewAuditorSelector,
      reviewAuditContract: this.reviewAuditContract,
    });
  }

  async runReviewEvidenceAudit(factory, task, taskSessionKey, routing, review, round) {
    const auditor = await factory.createReviewEvidenceAuditor(
      taskSessionKey,
      routing.route,
      routing.risk,
      `round-${round}`,
    );
    this.sessions.push(auditor.session);
    this.ui.agentConfiguration([
      { role: 'Review evidence auditor', model: auditor.model.name ?? auditor.model.id, effort: auditor.reasoningEffort },
    ]);
    try {
      const startedAt = Date.now();
      const report = await requireReport(
        auditor.session,
        auditor.sink,
        auditPrompt(task, review),
        'report_review_audit',
        this.agentTurnTimeoutMs,
      );
      const usage = await this.finishTurn(auditor, startedAt);
      this.ui?.audit?.({
        type: 'benchmark_review_evidence_audit',
        topology: this.experimentTopology,
        auditorSelector: this.reviewAuditorSelector,
        auditContract: factory.reviewAuditContract?.id ?? this.reviewAuditContract.id,
        taskId: task.id,
        round,
        report,
        usage,
      });
      this.ui?.phase?.(
        'Review evidence audit',
        report.adequate
          ? `Low-context ${auditor.model.name ?? auditor.model.id} auditor accepted the strong review evidence.`
          : `Low-context ${auditor.model.name ?? auditor.model.id} auditor rejected the strong review evidence; ${report.missing_or_weak_aspects.length} aspect(s) need reviewer evidence.`,
      );
      return report;
    } finally {
      await auditor.session.disconnect?.().catch(() => {});
      this.sessions = this.sessions.filter((session) => session !== auditor.session);
    }
  }

  async runFullTask(factory, task, taskSessionKey, routing, taskResumeState = null) {
    if (taskResumeState) {
      throw new Error('Review-evidence-auditor benchmark does not support /resume; start from a fresh fixture checkout.');
    }
    const effectiveRouting = this.benchmarkRouting({ ...routing, route: routing.route === 'trivial' ? 'standard' : routing.route }, false);
    let workerA;
    let reviewer;
    try {
      workerA = await factory.createWorker(taskSessionKey, 'A', effectiveRouting.route, effectiveRouting.risk);
      reviewer = await factory.createReviewer(taskSessionKey, effectiveRouting.route, effectiveRouting.risk);
      this.sessions.push(workerA.session, reviewer.session);
      this.ui.agentConfiguration([
        { role: 'A', model: workerA.model.name ?? workerA.model.id, effort: workerA.reasoningEffort },
        { role: 'Strong reviewer', model: reviewer.model.name ?? reviewer.model.id, effort: reviewer.reasoningEffort },
      ]);

      const initial = await this.runWorkerPass(workerA, task, 'IMPLEMENT', null, null);
      this.ui.passResult('A', initial.report, initial.changed, initial.revision, initial);
      const resolved = await this.resolveSingleWorkerPass(task, workerA, initial, effectiveRouting, {
        nextReviewCycle: 1,
      });
      const evidence = resolved.evidence;

      await this.saveTaskCheckpoint({
        stage: 'strong_review_pending',
        nextReviewCycle: 1,
        evidence,
        routing: effectiveRouting,
      });
      await this.checkAiCreditBudget(`before strong review for ${task.id}`);
      await super.runStrongReview(task, workerA, null, reviewer, evidence, effectiveRouting, {
        startReviewCycle: 1,
      });

      for (let round = 1; round <= this.maxReviewAuditRounds; round += 1) {
        const review = reviewer.sink.value;
        if (!review || review.verdict !== 'clean') {
          throw new Error('Strong review completed without a final CLEAN structured report for evidence auditing.');
        }
        await this.checkAiCreditBudget(`before review evidence audit ${round} for ${task.id}`);
        const audit = await this.runReviewEvidenceAudit(
          factory,
          task,
          taskSessionKey,
          effectiveRouting,
          review,
          round,
        );
        if (audit.adequate) return { route: effectiveRouting.route, escalated: false };
        if (round === this.maxReviewAuditRounds) {
          throw new Error(`Strong review evidence remained semantically inadequate after ${this.maxReviewAuditRounds} bounded low-context audit round(s).`);
        }

        queueRecoveryInstruction(
          reviewer.session,
          auditFeedback(audit, factory.reviewAuditContract ?? this.reviewAuditContract),
        );
        await this.checkAiCreditBudget(`before evidence-driven strong review retry for ${task.id}`);
        await super.runStrongReview(task, workerA, null, reviewer, evidence, effectiveRouting, {
          startReviewCycle: 1,
        });
      }
      throw new Error('Review evidence auditor loop ended unexpectedly.');
    } finally {
      await this.disposeTaskSessions([workerA?.session, reviewer?.session]);
    }
  }
}

module.exports = {
  REVIEW_AUDIT_TOOL,
  DEFAULT_MAX_REVIEW_AUDIT_ROUNDS,
  REVIEW_EVIDENCE_AUDITOR_PROMPT,
  REVIEW_AUDIT_ASPECTS,
  TRUST_BOUNDARY_REVIEW_AUDIT_CONTRACT,
  normalizeAuditContract,
  normalizeAuditReport,
  validateAuditReport,
  createReviewAuditTool,
  compactTaskForAudit,
  auditPrompt,
  auditFeedback,
  ReviewEvidenceAuditorSessionFactory,
  ReviewEvidenceAuditorBenchmarkEngine,
};
