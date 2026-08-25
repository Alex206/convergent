'use strict';

const {
  requireReport,
  taskPrompt,
  formatValidationEvidence,
  reconcileDeterministicIntegrity,
} = require('../orchestrator/engine');
const { formatTaskChangeManifest } = require('../orchestrator/task-change-manifest');
const { routePolicy, chooseReasoningEffort } = require('../orchestrator/routing');
const { reviewerFlowInstructions } = require('../orchestrator/flow');
const { workspaceScopePrompt } = require('../orchestrator/workspace-scope');
const { createReviewTool } = require('../copilot/tools');
const {
  attachEventLogging,
  readonlyHook,
  safeSessionPart,
  withReasoning,
} = require('../copilot/session-factory');
const {
  MAX_SELECTED_PROTOCOLS,
  createReviewPlanTool,
  formatPanelReports,
} = require('./review-protocols');
const {
  PANEL_MODES,
  PerspectiveReviewSessionFactory,
  PerspectiveReviewEngine,
} = require('./perspective-review-engine');

const ISOLATED_GENERIC_CONTROLLER_TOOLS = Object.freeze([
  'custom:report_review',
]);
const ISOLATED_PERSPECTIVE_CONTROLLER_TOOLS = Object.freeze([
  'custom:report_review_plan',
  'custom:report_review',
]);

const ISOLATED_GENERIC_ADJUDICATOR_PROMPT = `
You are Convergent's Terra adjudicator for the generic Luna-panel control arm.

You are deliberately NOT a fourth code reviewer. You have no repository inspection or command tools.
- Adjudicate only the three independent Luna reports plus deterministic task/validation/change evidence explicitly supplied in the prompt.
- Treat reports as evidence, not votes. Preserve a concrete well-supported panel finding even when other reviewers are clean; collapse duplicates and reject unsupported/speculative claims.
- Do not select review perspectives and do not originate a new repository-derived defect that no Luna reviewer reported.
- If every Luna reviewer is CLEAN and the supplied deterministic evidence does not explicitly report failure, return CLEAN. The external benchmark oracle, not Terra, measures defects the generic Luna panel missed.
- Call report_review exactly once with the final unresolved panel findings.
`.trim();

const ISOLATED_PERSPECTIVE_CONTROLLER_PROMPT = `
You are Convergent's Terra protocol selector and adjudicator for the perspective Luna-panel benchmark arm. You have no repository inspection or command tools. This is intentional: Terra may choose reusable perspectives and synthesize Luna evidence, but all repository-level defect discovery in this arm belongs to Luna.

PLANNING PHASE:
- Select exactly the requested number of reusable protocols from the supplied fixed catalog using only the task, deterministic validation/change evidence, and protocol descriptions supplied in the prompt.
- Select protocols because their generic search perspective is relevant to the task/change. Do not infer benchmark identity, hidden tests, or scenario-specific expected defects.
- Do not invent new protocols.
- Call report_review_plan exactly once.

ADJUDICATION PHASE:
- Adjudicate only the independent Luna reports plus deterministic evidence explicitly supplied in the prompt.
- Treat reports as evidence, not votes. Preserve a concrete well-supported panel finding even when other reviewers are clean; collapse duplicates and reject unsupported/speculative claims.
- Do not originate a new repository-derived defect that no Luna reviewer reported and do not turn the protocol-selection phase into an implicit Terra code review.
- If all Luna reviewers are CLEAN and supplied deterministic evidence does not explicitly report failure, return CLEAN. The external benchmark oracle measures defects the Luna panel missed.
- Call report_review exactly once with the final unresolved panel findings.
`.trim();

class IsolatedPerspectiveReviewSessionFactory extends PerspectiveReviewSessionFactory {
  async createReviewController(taskId, route = 'standard', risk = 'medium', options = {}) {
    const planningEnabled = options.planningEnabled !== false;
    const safeTaskId = safeSessionPart(taskId);
    const planSink = planningEnabled ? { value: null } : null;
    const reviewSink = { value: null };
    const planTool = planningEnabled
      ? createReviewPlanTool(this.sdk.defineTool, planSink, { expectedCount: MAX_SELECTED_PROTOCOLS })
      : null;
    const reviewTool = createReviewTool(this.sdk.defineTool, reviewSink);
    const name = 'Terra review controller';
    const model = this.models.reviewer;
    const effort = chooseReasoningEffort(
      model,
      routePolicy(route, risk).efforts.reviewer,
      this.reasoningMode,
    );
    const baselinePrompt = await this.taskBaselinePrompt(taskId);
    const controllerPrompt = planningEnabled
      ? ISOLATED_PERSPECTIVE_CONTROLLER_PROMPT
      : ISOLATED_GENERIC_ADJUDICATOR_PROMPT;
    const availableTools = planningEnabled
      ? ISOLATED_PERSPECTIVE_CONTROLLER_TOOLS
      : ISOLATED_GENERIC_CONTROLLER_TOOLS;
    const tools = planningEnabled ? [planTool, reviewTool] : [reviewTool];
    const systemPrompt = [
      controllerPrompt,
      reviewerFlowInstructions(this.flowMode),
      workspaceScopePrompt(this.workspace, this.workspaceFolders),
      baselinePrompt,
    ].filter(Boolean).join('\n\n');

    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-review-controller`,
      clientName: 'convergent-perspective-review-benchmark',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools,
      availableTools,
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: { onPreToolUse: (input) => this.preToolUse(readonlyHook, name, input) },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));

    const guard = this.guard(session, name);
    const usageKey = `${safeTaskId}:review-controller`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey, null);
    this.ui.agentTools?.(name, availableTools);
    this.sessionCreated(name, session, model, effort, systemPrompt, availableTools, {
      role: 'review-controller',
      taskId: safeTaskId,
      benchmarkOnly: true,
      planningEnabled,
      repositoryInspectionEnabled: false,
    });

    return {
      session,
      guard,
      planSink,
      reviewSink,
      name,
      usageName: usageKey,
      model,
      reasoningEffort: effort,
      planningEnabled,
    };
  }
}

class IsolatedPerspectiveReviewEngine extends PerspectiveReviewEngine {
  sessionFactory() {
    return new IsolatedPerspectiveReviewSessionFactory({
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
      benchmarkToolProfile: 'structured',
    });
  }

  async runControllerAdjudication(controller, task, panelReports, evidence, routing, cycle) {
    const before = await this.revisionProvider(this.workspace, this.workspaceFolders);
    const manifest = await this.currentTaskChangeManifest(this.activeTaskChangeContext);
    const startedAt = Date.now();
    controller.reviewSink.value = null;
    let review = await requireReport(
      controller.session,
      controller.reviewSink,
      [
        'PHASE: ADJUDICATION',
        taskPrompt(task),
        '',
        `ADJUDICATION CYCLE: ${cycle}/${this.maxReviewerCycles}`,
        `Current workspace revision fingerprint: ${before}.`,
        `Task workflow: ${routing.route}; task risk: ${routing.risk}.`,
        formatValidationEvidence(evidence),
        manifest
          ? `\n${formatTaskChangeManifest(manifest, 'Deterministic task change manifest for panel adjudication')}`
          : '',
        '',
        'Independent Luna panel reports:',
        formatPanelReports(panelReports),
        '',
        this.reviewMode === PANEL_MODES.perspective
          ? 'This is the perspective-panel arm. Synthesize only the supplied Luna reports and deterministic evidence. Do not originate findings from protocol-planning context or repository inspection. Call report_review exactly once.'
          : 'This is the generic-panel control arm. Synthesize only the three ordinary broad Luna reports and deterministic evidence. Do not select perspectives or originate findings from repository inspection. Call report_review exactly once.',
      ].filter(Boolean).join('\n'),
      'report_review',
      this.agentTurnTimeoutMs,
    );
    const integrity = reconcileDeterministicIntegrity(review, {
      changed: false,
      role: 'Terra review controller',
      credentialViolations: this.operatorCredentialGuard?.consumeViolations('Terra review controller') ?? [],
      validationEvidence: evidence,
    });
    review = integrity.report;
    if (integrity.correction) this.ui?.log?.(`Terra review-controller verdict reconciled: ${integrity.correction}`);
    const after = await this.revisionProvider(this.workspace, this.workspaceFolders);
    const usage = await this.finishTurn(controller, startedAt);
    const durationMs = Date.now() - startedAt;
    if (before !== after) throw new Error('Terra review controller changed the workspace despite the read-only contract.');
    this.ui.reviewResult(review, cycle, { durationMs, usage });
    this.ui?.audit?.({
      type: 'benchmark_panel_adjudication',
      taskId: task.id,
      reviewMode: this.reviewMode,
      cycle,
      verdict: review.verdict,
      findings: review.findings ?? [],
      usage,
      repositoryInspectionEnabled: false,
    });
    return review;
  }
}

module.exports = {
  ISOLATED_GENERIC_CONTROLLER_TOOLS,
  ISOLATED_PERSPECTIVE_CONTROLLER_TOOLS,
  ISOLATED_GENERIC_ADJUDICATOR_PROMPT,
  ISOLATED_PERSPECTIVE_CONTROLLER_PROMPT,
  IsolatedPerspectiveReviewSessionFactory,
  IsolatedPerspectiveReviewEngine,
};