'use strict';

const {
  requireReport,
  taskPrompt,
  formatValidationEvidence,
} = require('../orchestrator/engine');
const { formatTaskChangeManifest } = require('../orchestrator/task-change-manifest');
const { chooseReasoningEffort } = require('../orchestrator/routing');
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
  BenchmarkTopologyEngine,
  LeanStandardSessionFactory,
  STRUCTURED_REVIEWER_TOOLS,
} = require('./topology-engine');
const {
  PANEL_REVIEWER_COMMON_PROMPT,
  panelReviewersForMode,
} = require('./review-protocols');

class PerspectivePanelSessionFactory extends LeanStandardSessionFactory {
  async createPanelReviewer(taskId, panelReviewer, route = 'standard', risk = 'medium') {
    const safeTaskId = safeSessionPart(taskId);
    const reviewerId = safeSessionPart(panelReviewer.id);
    const sink = { value: null };
    const tool = createReviewTool(this.sdk.defineTool, sink);
    const batchView = this.batchViewTool();
    const name = `Panel ${panelReviewer.label}`;
    let guard = null;
    const runCommand = this.runCommandTool(name, () => guard);
    const model = this.workerModel(taskId, 'B', route, risk);
    const effort = chooseReasoningEffort(model, 'medium', this.reasoningMode);
    const baselinePrompt = await this.taskBaselinePrompt(taskId);
    const systemPrompt = [
      PANEL_REVIEWER_COMMON_PROMPT,
      panelReviewer.prompt,
      reviewerFlowInstructions(this.flowMode),
      workspaceScopePrompt(this.workspace, this.workspaceFolders),
      baselinePrompt,
    ].filter(Boolean).join('\n\n');

    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-panel-${reviewerId}`,
      clientName: 'convergent-headless-perspective-benchmark',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [batchView, runCommand, tool],
      availableTools: [...STRUCTURED_REVIEWER_TOOLS],
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: {
        onPreToolUse: (input) => this.preToolUse(readonlyHook, name, input),
      },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));

    guard = this.guard(session, name);
    const usageKey = `${safeTaskId}:panel-${reviewerId}`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey, {
      sink,
      toolName: 'report_review',
    });
    this.ui.agentTools?.(name, STRUCTURED_REVIEWER_TOOLS);
    this.sessionCreated(name, session, model, effort, systemPrompt, STRUCTURED_REVIEWER_TOOLS, {
      role: 'panel-reviewer',
      taskId: safeTaskId,
      route,
      risk,
      benchmarkOnly: true,
      reviewPanelId: panelReviewer.id,
      reviewPanelLabel: panelReviewer.label,
    });

    return {
      session,
      guard,
      sink,
      name,
      usageName: usageKey,
      model,
      reasoningEffort: effort,
      panelReviewer,
    };
  }
}

class PerspectivePanelTopologyEngine extends BenchmarkTopologyEngine {
  sessionFactory() {
    return new PerspectivePanelSessionFactory({
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
    const panelMode = this.topologyConfig.panelMode;
    if (!panelMode) {
      return super.runFullTask(factory, task, taskSessionKey, routing, taskResumeState);
    }
    if (taskResumeState) {
      throw new Error('Review-panel benchmark topologies do not support /resume; start from a fresh fixture checkout.');
    }
    return this.runPanelTask(
      factory,
      task,
      taskSessionKey,
      this.benchmarkRouting(routing, false),
      panelMode,
    );
  }

  async runPanelReviewPass(panelReviewer, task, evidence, expectedRevision) {
    const before = await this.revisionProvider(this.workspace, this.workspaceFolders);
    if (before !== expectedRevision) {
      throw new Error(`Review panel revision drift before ${panelReviewer.panelReviewer.id}: expected ${expectedRevision}, got ${before}.`);
    }
    const manifest = await this.currentTaskChangeManifest(this.activeTaskChangeContext);
    const startedAt = Date.now();
    const review = await requireReport(
      panelReviewer.session,
      panelReviewer.sink,
      [
        taskPrompt(task),
        '',
        `REVIEW PANEL CHARTER: ${panelReviewer.panelReviewer.label} (${panelReviewer.panelReviewer.id}).`,
        `Current workspace revision fingerprint: ${before}.`,
        formatValidationEvidence(evidence),
        manifest
          ? `\n${formatTaskChangeManifest(manifest, `Deterministic task change manifest for ${panelReviewer.panelReviewer.label}`)}`
          : '',
        '',
        'Apply only your assigned review charter to this exact revision. Work independently of other panel reviewers. Do not edit files. Call report_review exactly once.',
      ].filter(Boolean).join('\n'),
      'report_review',
      this.agentTurnTimeoutMs,
    );
    const after = await this.revisionProvider(this.workspace, this.workspaceFolders);
    const usage = await this.finishTurn(panelReviewer, startedAt);
    if (before !== after) {
      throw new Error(`Review panel member ${panelReviewer.panelReviewer.id} changed the workspace despite the read-only contract.`);
    }
    this.ui?.audit?.({
      type: 'benchmark_panel_review_result',
      topology: this.topology,
      taskId: task.id,
      panelMode: this.topologyConfig.panelMode,
      perspective: panelReviewer.panelReviewer.id,
      verdict: review.verdict,
      summary: review.summary,
      findings: review.findings ?? [],
      usage,
      revision: before,
    });
    this.ui?.phase?.(
      'Review panel',
      review.verdict === 'clean'
        ? `${panelReviewer.panelReviewer.label} found no actionable defect.`
        : `${panelReviewer.panelReviewer.label} returned ${review.findings?.length ?? 0} finding(s).`,
    );
    return review;
  }

  async runPanelTask(factory, task, taskSessionKey, routing, panelMode) {
    let workerA;
    let reviewer;
    const panelSessions = [];
    try {
      workerA = await factory.createWorker(taskSessionKey, 'A', routing.route, routing.risk);
      const panelSpecs = panelReviewersForMode(panelMode);
      for (const spec of panelSpecs) {
        panelSessions.push(await factory.createPanelReviewer(taskSessionKey, spec, routing.route, routing.risk));
      }
      reviewer = await factory.createReviewer(taskSessionKey, routing.route, routing.risk);
      this.sessions.push(workerA.session, ...panelSessions.map((entry) => entry.session), reviewer.session);
      this.ui.agentConfiguration([
        { role: 'A', model: workerA.model.name ?? workerA.model.id, effort: workerA.reasoningEffort },
        ...panelSessions.map((entry) => ({
          role: `Panel:${entry.panelReviewer.id}`,
          model: entry.model.name ?? entry.model.id,
          effort: entry.reasoningEffort,
        })),
        { role: 'Strong reviewer', model: reviewer.model.name ?? reviewer.model.id, effort: reviewer.reasoningEffort },
      ]);

      const initial = await this.runWorkerPass(workerA, task, 'IMPLEMENT', null, null);
      this.ui.passResult('A', initial.report, initial.changed, initial.revision, initial);
      let resolved = await this.resolveSingleWorkerPass(task, workerA, initial, routing, {
        nextReviewCycle: 1,
      });
      let evidence = resolved.evidence;
      const panelRevision = await this.revisionProvider(this.workspace, this.workspaceFolders);
      const panelFindings = [];

      for (const panelReviewer of panelSessions) {
        await this.checkAiCreditBudget(`before review-panel member ${panelReviewer.panelReviewer.id} for ${task.id}`);
        const panelReview = await this.runPanelReviewPass(panelReviewer, task, evidence, panelRevision);
        if (panelReview.verdict === 'blocked') {
          throw new Error(`Review panel member ${panelReviewer.panelReviewer.id} is blocked: ${panelReview.summary}`);
        }
        if (panelReview.verdict === 'findings' && !panelReview.findings?.length) {
          throw new Error(`Review panel member ${panelReviewer.panelReviewer.id} returned FINDINGS without actionable findings.`);
        }
        if (panelReview.verdict === 'findings') panelFindings.push(...panelReview.findings);
      }

      if (panelFindings.length) {
        this.ui?.phase?.(
          'Panel remediation',
          `Worker A is addressing ${panelFindings.length} finding(s) collected independently by the ${panelMode} review panel.`,
        );
        const remediation = await this.runWorkerPass(
          workerA,
          task,
          'FIX_REVIEW_PANEL_FINDINGS',
          panelFindings,
          null,
        );
        this.ui.passResult('A', remediation.report, remediation.changed, remediation.revision, remediation);
        resolved = await this.resolveSingleWorkerPass(task, workerA, remediation, routing, {
          nextReviewCycle: 1,
        });
        evidence = resolved.evidence;
      }

      await this.saveTaskCheckpoint({
        stage: 'strong_review_pending',
        nextReviewCycle: 1,
        evidence,
        routing,
      });
      await this.checkAiCreditBudget(`before strong review for ${task.id}`);
      await this.runStrongReview(task, workerA, null, reviewer, evidence, routing, {
        startReviewCycle: 1,
      });
      return { route: routing.route, escalated: false };
    } finally {
      await this.disposeTaskSessions([
        workerA?.session,
        ...panelSessions.map((entry) => entry?.session),
        reviewer?.session,
      ]);
    }
  }
}

module.exports = {
  PerspectivePanelSessionFactory,
  PerspectivePanelTopologyEngine,
};
