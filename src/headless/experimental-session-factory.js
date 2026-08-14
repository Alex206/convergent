'use strict';

const {
  SessionFactory,
  attachEventLogging,
  readonlyHook,
  workerHook,
  safeSessionPart,
  withReasoning,
  WORKER_TOOLS,
  REVIEWER_TOOLS,
} = require('../copilot/session-factory');
const { WORKER_A_PROMPT, WORKER_B_PROMPT, REVIEWER_PROMPT } = require('../orchestrator/prompts');
const { routePolicy, chooseReasoningEffort } = require('../orchestrator/routing');
const { workerFlowInstructions, reviewerFlowInstructions } = require('../orchestrator/flow');
const { createPassTool, createReviewTool } = require('../copilot/tools');
const { reconcileUnsupportedBlockedReport } = require('./report-integrity-guard');

function createIntegritySink(role, ui) {
  let value = null;
  const corrections = [];
  return {
    corrections,
    get value() {
      return value;
    },
    set value(next) {
      if (!next || typeof next !== 'object') {
        value = next;
        return;
      }
      const reconciled = reconcileUnsupportedBlockedReport(next, { changed: false, role });
      value = reconciled.report;
      if (reconciled.correction) {
        corrections.push(reconciled.correction);
        ui?.log?.(reconciled.correction);
      }
    },
  };
}

class ExperimentalSessionFactory extends SessionFactory {
  constructor(options = {}) {
    super(options);
    this.operatorCredentialGuard = options.operatorCredentialGuard ?? null;
  }

  preToolUse(baseHook, agent, input) {
    const base = baseHook(input);
    if (base?.permissionDecision === 'deny') return base;
    return this.operatorCredentialGuard?.hook(input, { agent }) ?? base;
  }

  async createWorker(taskId, worker, route = 'standard', risk = 'medium') {
    const safeTaskId = safeSessionPart(taskId);
    const sink = createIntegritySink(`Worker ${worker}`, this.ui);
    const tool = createPassTool(this.sdk.defineTool, sink);
    const batchView = this.batchViewTool();
    const isA = worker === 'A';
    const role = isA ? 'workerA' : 'workerB';
    const model = this.workerModel(taskId, worker, route, risk);
    const desiredEffort = routePolicy(route, risk).efforts[role];
    const effort = chooseReasoningEffort(model, desiredEffort, this.reasoningMode);
    const baselinePrompt = await this.taskBaselinePrompt(taskId);
    const systemPrompt = [
      isA ? WORKER_A_PROMPT : WORKER_B_PROMPT,
      workerFlowInstructions(this.flowMode),
      baselinePrompt,
    ].filter(Boolean).join('\n\n');

    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-worker-${worker.toLowerCase()}`,
      clientName: 'convergent-vscode',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [batchView, tool],
      availableTools: WORKER_TOOLS,
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: { onPreToolUse: (input) => this.preToolUse(workerHook, worker, input) },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));

    const name = `Worker ${worker}`;
    const guard = this.guard(session, name);
    const usageKey = `${safeTaskId}:worker-${worker.toLowerCase()}`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey, { sink, toolName: 'report_pass' });
    this.ui.agentTools?.(name, WORKER_TOOLS);
    this.sessionCreated(name, session, model, effort, systemPrompt, WORKER_TOOLS, {
      role,
      taskId: safeTaskId,
      route,
      risk,
      operatorCredentialGuard: Boolean(this.operatorCredentialGuard),
      reportIntegrityGuard: true,
    });
    return { session, guard, sink, name: worker, usageName: usageKey, model, reasoningEffort: effort };
  }

  async createReviewer(taskId, route = 'standard', risk = 'medium') {
    const safeTaskId = safeSessionPart(taskId);
    const sink = createIntegritySink('Strong reviewer', this.ui);
    const tool = createReviewTool(this.sdk.defineTool, sink);
    const batchView = this.batchViewTool();
    const model = this.models.reviewer;
    const desiredEffort = routePolicy(route, risk).efforts.reviewer;
    const effort = chooseReasoningEffort(model, desiredEffort, this.reasoningMode);
    const baselinePrompt = await this.taskBaselinePrompt(taskId);
    const systemPrompt = [
      REVIEWER_PROMPT,
      reviewerFlowInstructions(this.flowMode),
      baselinePrompt,
    ].filter(Boolean).join('\n\n');

    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-reviewer`,
      clientName: 'convergent-vscode',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [batchView, tool],
      availableTools: REVIEWER_TOOLS,
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: { onPreToolUse: (input) => this.preToolUse(readonlyHook, 'Strong reviewer', input) },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));

    const name = 'Strong reviewer';
    const guard = this.guard(session, name);
    const usageKey = `${safeTaskId}:reviewer`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey, { sink, toolName: 'report_review' });
    this.ui.agentTools?.(name, REVIEWER_TOOLS);
    this.sessionCreated(name, session, model, effort, systemPrompt, REVIEWER_TOOLS, {
      role: 'reviewer',
      taskId: safeTaskId,
      route,
      risk,
      operatorCredentialGuard: Boolean(this.operatorCredentialGuard),
      reportIntegrityGuard: true,
    });
    return { session, guard, sink, name, usageName: usageKey, model, reasoningEffort: effort };
  }
}

module.exports = { ExperimentalSessionFactory, createIntegritySink };
