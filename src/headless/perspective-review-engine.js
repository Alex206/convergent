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
  LeanStandardSessionFactory,
  BenchmarkTopologyEngine,
  STRUCTURED_REVIEWER_TOOLS,
} = require('./topology-engine');
const {
  MAX_SELECTED_PROTOCOLS,
  GENERIC_LUNA_REVIEW_PROMPT,
  REVIEW_CONTROLLER_PROMPT,
  formatReviewProtocolCatalog,
  createReviewPlanTool,
  perspectiveSystemPrompt,
  formatPanelReports,
} = require('./review-protocols');

const PANEL_MODES = Object.freeze({
  generic: 'generic',
  perspective: 'perspective',
});

const GENERIC_PANEL_SIZE = 3;
const REVIEW_CONTROLLER_TOOLS = Object.freeze([
  ...STRUCTURED_REVIEWER_TOOLS.filter((name) => name !== 'custom:report_review'),
  'custom:report_review_plan',
  'custom:report_review',
]);

class PerspectiveReviewSessionFactory extends LeanStandardSessionFactory {
  async createPanelReviewer(taskId, reviewerId, label, systemPromptContent, route = 'standard', risk = 'medium') {
    const safeTaskId = safeSessionPart(taskId);
    const safeReviewerId = safeSessionPart(reviewerId);
    const sink = { value: null };
    const tool = createReviewTool(this.sdk.defineTool, sink);
    const batchView = this.batchViewTool();
    const name = `Luna review: ${label}`;
    let guard = null;
    const runCommand = this.runCommandTool(name, () => guard);
    const model = this.workerModel(`${taskId}-review-${reviewerId}`, 'A', route, risk);
    const effort = chooseReasoningEffort(model, 'medium', this.reasoningMode);
    const baselinePrompt = await this.taskBaselinePrompt(taskId);
    const systemPrompt = [
      systemPromptContent,
      reviewerFlowInstructions(this.flowMode),
      workspaceScopePrompt(this.workspace, this.workspaceFolders),
      baselinePrompt,
    ].filter(Boolean).join('\n\n');

    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-panel-${safeReviewerId}`,
      clientName: 'convergent-perspective-review-benchmark',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [batchView, runCommand, tool],
      availableTools: STRUCTURED_REVIEWER_TOOLS,
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: { onPreToolUse: (input) => this.preToolUse(readonlyHook, name, input) },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));

    guard = this.guard(session, name);
    const usageKey = `${safeTaskId}:panel:${safeReviewerId}`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey, {
      sink,
      toolName: 'report_review',
    });
    this.ui.agentTools?.(name, STRUCTURED_REVIEWER_TOOLS);
    this.sessionCreated(name, session, model, effort, systemPrompt, STRUCTURED_REVIEWER_TOOLS, {
      role: 'panel-reviewer',
      taskId: safeTaskId,
      reviewerId,
      benchmarkOnly: true,
    });

    return {
      session,
      guard,
      sink,
      name,
      reviewerId,
      label,
      usageName: usageKey,
      model,
      reasoningEffort: effort,
    };
  }

  async createGenericPanelReviewer(taskId, index, route = 'standard', risk = 'medium') {
    return this.createPanelReviewer(
      taskId,
      `generic-${index}`,
      `generic ${index}`,
      GENERIC_LUNA_REVIEW_PROMPT,
      route,
      risk,
    );
  }

  async createPerspectiveReviewer(taskId, protocolId, route = 'standard', risk = 'medium') {
    return this.createPanelReviewer(
      taskId,
      `protocol-${protocolId}`,
      protocolId,
      perspectiveSystemPrompt(protocolId),
      route,
      risk,
    );
  }

  async createReviewController(taskId, route = 'standard', risk = 'medium') {
    const safeTaskId = safeSessionPart(taskId);
    const planSink = { value: null };
    const reviewSink = { value: null };
    const planTool = createReviewPlanTool(this.sdk.defineTool, planSink, {
      expectedCount: MAX_SELECTED_PROTOCOLS,
    });
    const reviewTool = createReviewTool(this.sdk.defineTool, reviewSink);
    const batchView = this.batchViewTool();
    const name = 'Terra review controller';
    let guard = null;
    const runCommand = this.runCommandTool(name, () => guard);
    const model = this.models.reviewer;
    const effort = chooseReasoningEffort(
      model,
      routePolicy(route, risk).efforts.reviewer,
      this.reasoningMode,
    );
    const baselinePrompt = await this.taskBaselinePrompt(taskId);
    const systemPrompt = [
      REVIEW_CONTROLLER_PROMPT,
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
      tools: [batchView, runCommand, planTool, reviewTool],
      availableTools: REVIEW_CONTROLLER_TOOLS,
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: { onPreToolUse: (input) => this.preToolUse(readonlyHook, name, input) },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));

    guard = this.guard(session, name);
    const usageKey = `${safeTaskId}:review-controller`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey, null);
    this.ui.agentTools?.(name, REVIEW_CONTROLLER_TOOLS);
    this.sessionCreated(name, session, model, effort, systemPrompt, REVIEW_CONTROLLER_TOOLS, {
      role: 'review-controller',
      taskId: safeTaskId,
      benchmarkOnly: true,
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
    };
  }
}

class PerspectiveReviewEngine extends BenchmarkTopologyEngine {
  constructor(options = {}) {
    super({ ...options, topology: 'luna-terra-structured' });
    const requestedMode = String(options.reviewMode ?? PANEL_MODES.perspective).toLowerCase();
    if (!Object.hasOwn(PANEL_MODES, requestedMode)) {
      throw new Error(`Unsupported panel review mode ${JSON.stringify(options.reviewMode)}.`);
    }
    this.reviewMode = requestedMode;
  }

  sessionFactory() {
    return new PerspectiveReviewSessionFactory({
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

  async runFullTask(factory, task, taskSessionKey, routing, taskResumeState = null) {
    if (taskResumeState) {
      throw new Error('Panel-review benchmark does not support /resume; start from a fresh fixture checkout.');
    }
    return this.runPanelReviewTask(factory, task, taskSessionKey, {
      ...routing,
      peerConvergence: false,
    });
  }

  async runReviewPlan(controller, task, evidence, routing) {
    const before = await this.revisionProvider(this.workspace, this.workspaceFolders);
    const manifest = await this.currentTaskChangeManifest(this.activeTaskChangeContext);
    const startedAt = Date.now();
    controller.planSink.value = null;
    const plan = await requireReport(
      controller.session,
      controller.planSink,
      [
        'PHASE: PLANNING',
        taskPrompt(task),
        '',
        `Current workspace revision fingerprint: ${before}.`,
        `Task workflow: ${routing.route}; task risk: ${routing.risk}.`,
        formatValidationEvidence(evidence),
        manifest
          ? `\n${formatTaskChangeManifest(manifest, 'Deterministic task change manifest for review planning')}`
          : '',
        '',
        `Select exactly ${MAX_SELECTED_PROTOCOLS} complementary protocols from this fixed reusable catalog:`,
        formatReviewProtocolCatalog(),
        '',
        'Do not identify the benchmark scenario or guess hidden tests. Select by generic risk/semantics of the current task and change. Call report_review_plan exactly once.',
      ].filter(Boolean).join('\n'),
      'report_review_plan',
      this.agentTurnTimeoutMs,
    );
    const after = await this.revisionProvider(this.workspace, this.workspaceFolders);
    const usage = await this.finishTurn(controller, startedAt);
    if (before !== after) throw new Error('Review controller changed the workspace during protocol selection.');
    this.ui?.audit?.({
      type: 'benchmark_review_protocol_plan',
      taskId: task.id,
      reviewMode: this.reviewMode,
      selected: plan.selected,
      rationale: plan.rationale,
      usage,
    });
    this.ui?.phase?.('Review planning', `Terra selected Luna perspectives: ${plan.selected.join(', ')}.`);
    return plan;
  }

  async runPanelReviewerPass(reviewer, task, evidence, routing, cycle) {
    const before = await this.revisionProvider(this.workspace, this.workspaceFolders);
    const manifest = await this.currentTaskChangeManifest(this.activeTaskChangeContext);
    const startedAt = Date.now();
    const report = await requireReport(
      reviewer.session,
      reviewer.sink,
      [
        taskPrompt(task),
        '',
        `PANEL REVIEW CYCLE: ${cycle}/${this.maxReviewerCycles}`,
        `Assigned reviewer: ${reviewer.label}.`,
        `Current workspace revision fingerprint: ${before}.`,
        `Task workflow: ${routing.route}; task risk: ${routing.risk}.`,
        formatValidationEvidence(evidence),
        manifest
          ? `\n${formatTaskChangeManifest(manifest, `Deterministic task change manifest for ${reviewer.label} review`)}`
          : '',
        '',
        cycle > 1
          ? 'Re-check the prior state through your assigned perspective, focusing on the remediation delta and any regression it creates. Remain independent of the other panel reviewers.'
          : 'Apply only your assigned review charter to the exact current change. Remain independent of the other panel reviewers.',
        'Do not edit files. Call report_review exactly once.',
      ].filter(Boolean).join('\n'),
      'report_review',
      this.agentTurnTimeoutMs,
    );
    const after = await this.revisionProvider(this.workspace, this.workspaceFolders);
    const usage = await this.finishTurn(reviewer, startedAt);
    if (before !== after) throw new Error(`${reviewer.name} changed the workspace despite the read-only contract.`);
    this.ui?.audit?.({
      type: 'benchmark_panel_review_result',
      taskId: task.id,
      reviewMode: this.reviewMode,
      reviewerId: reviewer.reviewerId,
      label: reviewer.label,
      cycle,
      verdict: report.verdict,
      summary: report.summary,
      findings: report.findings ?? [],
      checks: report.checks ?? [],
      usage,
    });
    return { reviewerId: reviewer.reviewerId, label: reviewer.label, report };
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
        'Treat reports as evidence, not votes. Validate disputed/high-impact findings with only the targeted inspection needed. Do not redo a broad generic review. Call report_review exactly once with the final unresolved actionable findings.',
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
    });
    return review;
  }

  async createPanel(factory, taskSessionKey, task, routing, controller, evidence) {
    if (this.reviewMode === PANEL_MODES.generic) {
      const reviewers = [];
      for (let index = 1; index <= GENERIC_PANEL_SIZE; index += 1) {
        reviewers.push(await factory.createGenericPanelReviewer(taskSessionKey, index, routing.route, routing.risk));
      }
      return { reviewers, reviewPlan: null };
    }

    const reviewPlan = await this.runReviewPlan(controller, task, evidence, routing);
    const reviewers = [];
    for (const protocolId of reviewPlan.selected) {
      reviewers.push(await factory.createPerspectiveReviewer(taskSessionKey, protocolId, routing.route, routing.risk));
    }
    return { reviewers, reviewPlan };
  }

  async runPanelReviewTask(factory, task, taskSessionKey, routing) {
    let workerA;
    let controller;
    let reviewers = [];
    try {
      workerA = await factory.createWorker(taskSessionKey, 'A', routing.route, routing.risk);
      controller = await factory.createReviewController(taskSessionKey, routing.route, routing.risk);
      this.sessions.push(workerA.session, controller.session);

      const initial = await this.runWorkerPass(workerA, task, 'IMPLEMENT', null, null);
      this.ui.passResult('A', initial.report, initial.changed, initial.revision, initial);
      let resolved = await this.resolveSingleWorkerPass(task, workerA, initial, routing, {
        nextReviewCycle: 1,
      });
      let evidence = resolved.evidence;

      const panel = await this.createPanel(factory, taskSessionKey, task, routing, controller, evidence);
      reviewers = panel.reviewers;
      this.sessions.push(...reviewers.map((reviewer) => reviewer.session));
      this.ui.agentConfiguration([
        { role: 'A', model: workerA.model.name ?? workerA.model.id, effort: workerA.reasoningEffort },
        ...reviewers.map((reviewer) => ({
          role: reviewer.name,
          model: reviewer.model.name ?? reviewer.model.id,
          effort: reviewer.reasoningEffort,
        })),
        { role: 'Terra review controller', model: controller.model.name ?? controller.model.id, effort: controller.reasoningEffort },
      ]);

      for (let cycle = 1; cycle <= this.maxReviewerCycles; cycle += 1) {
        await this.checkAiCreditBudget(`before review panel cycle ${cycle} for ${task.id}`);
        const panelReports = [];
        for (const reviewer of reviewers) {
          panelReports.push(await this.runPanelReviewerPass(reviewer, task, evidence, routing, cycle));
        }

        const adjudication = await this.runControllerAdjudication(
          controller,
          task,
          panelReports,
          evidence,
          routing,
          cycle,
        );
        if (adjudication.verdict === 'clean') {
          return { route: routing.route, escalated: false };
        }
        if (adjudication.verdict === 'blocked') {
          throw new Error(`Terra review controller is blocked: ${adjudication.summary}`);
        }
        if (!adjudication.findings?.length) {
          throw new Error('Terra review controller returned FINDINGS without actionable findings.');
        }
        if (cycle === this.maxReviewerCycles) {
          throw new Error(`Panel adjudication still has findings after ${this.maxReviewerCycles} remediation cycle(s).`);
        }

        this.ui?.phase?.(
          'Panel remediation',
          `Worker A is addressing ${adjudication.findings.length} adjudicated finding(s); the independent Luna panel will re-check the resulting revision.`,
        );
        const remediation = await this.runWorkerPass(
          workerA,
          task,
          'FIX_STRONG_REVIEW_FINDINGS',
          adjudication.findings,
          null,
        );
        this.ui.passResult('A', remediation.report, remediation.changed, remediation.revision, remediation);
        resolved = await this.resolveSingleWorkerPass(task, workerA, remediation, routing, {
          nextReviewCycle: cycle + 1,
        });
        evidence = resolved.evidence;
      }

      throw new Error('Panel review ended without a final verdict.');
    } finally {
      await this.disposeTaskSessions([
        workerA?.session,
        controller?.session,
        ...reviewers.map((reviewer) => reviewer?.session),
      ]);
    }
  }
}

module.exports = {
  PANEL_MODES,
  GENERIC_PANEL_SIZE,
  REVIEW_CONTROLLER_TOOLS,
  PerspectiveReviewSessionFactory,
  PerspectiveReviewEngine,
};
