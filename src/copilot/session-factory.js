'use strict';

const {
  COORDINATOR_PROMPT,
  WORKER_A_PROMPT,
  WORKER_B_PROMPT,
  REVIEWER_PROMPT,
} = require('../orchestrator/prompts');
const { routePolicy, chooseReasoningEffort } = require('../orchestrator/routing');
const { createPlanTool, createPassTool, createReviewTool } = require('./tools');

function readonlyHook(input) {
  const name = String(input.toolName ?? '').toLowerCase();
  if (/(^|[_-])(edit|write|delete|create|apply.?patch)($|[_-])/.test(name)) {
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: 'This Convergent role is read-only.',
    };
  }
  return { permissionDecision: 'allow' };
}

function safeSessionPart(value) {
  const part = String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (part || 'task').slice(0, 80);
}

function attachEventLogging(session, agentName, ui, usage, model, usageKey = agentName) {
  usage?.register(usageKey, session, model, agentName);
  const disposers = [];
  disposers.push(
    session.on('assistant.intent', (event) => ui.agentIntent(agentName, event.data.intent)),
    session.on('tool.execution_start', (event) => ui.agentTool(agentName, event.data.toolName)),
    session.on('assistant.message', (event) => ui.agentMessage(agentName, event.data.content)),
    session.on('assistant.usage', (event) => {
      usage?.recordAssistantUsage(usageKey, event.data);
      ui.agentUsageEvent?.(agentName, usage?.summary());
    }),
    session.on('session.usage_checkpoint', (event) => {
      usage?.recordCheckpoint(usageKey, event.data);
      ui.agentUsageEvent?.(agentName, usage?.summary());
    }),
    session.on('session.usage_info', (event) => usage?.recordContext(usageKey, event.data)),
    session.on('session.error', (event) => ui.agentError(agentName, event.data.message)),
  );
  return () => disposers.forEach((dispose) => dispose?.());
}

function withReasoning(options, effort) {
  return effort ? { ...options, reasoningEffort: effort } : options;
}

class SessionFactory {
  constructor({ client, sdk, workspace, models, permissionHandler, userInputHandler, ui, usage, runId, reasoningMode = 'adaptive' }) {
    this.client = client;
    this.sdk = sdk;
    this.workspace = workspace;
    this.models = models;
    this.permissionHandler = permissionHandler;
    this.userInputHandler = userInputHandler;
    this.ui = ui;
    this.usage = usage;
    this.runId = runId;
    this.reasoningMode = reasoningMode;
  }

  async createCoordinator() {
    const sink = { value: null };
    const tool = createPlanTool(this.sdk.defineTool, sink);
    const model = this.models.coordinator;
    const effort = chooseReasoningEffort(model, 'medium', this.reasoningMode);
    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-coordinator`,
      clientName: 'convergent-vscode',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [tool],
      systemMessage: { mode: 'append', content: COORDINATOR_PROMPT },
      excludedTools: ['edit'],
      hooks: { onPreToolUse: readonlyHook },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));
    const usageKey = 'coordinator';
    attachEventLogging(session, 'Coordinator', this.ui, this.usage, model, usageKey);
    return { session, sink, name: 'Coordinator', usageName: usageKey, model, reasoningEffort: effort };
  }

  async createWorker(taskId, worker, route = 'standard') {
    const safeTaskId = safeSessionPart(taskId);
    const sink = { value: null };
    const tool = createPassTool(this.sdk.defineTool, sink);
    const isA = worker === 'A';
    const role = isA ? 'workerA' : 'workerB';
    const model = isA ? this.models.workerA : this.models.workerB;
    const desiredEffort = routePolicy(route).efforts[role];
    const effort = chooseReasoningEffort(model, desiredEffort, this.reasoningMode);
    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-worker-${worker.toLowerCase()}`,
      clientName: 'convergent-vscode',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [tool],
      systemMessage: { mode: 'append', content: isA ? WORKER_A_PROMPT : WORKER_B_PROMPT },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));
    const name = `Worker ${worker}`;
    const usageKey = `${safeTaskId}:worker-${worker.toLowerCase()}`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey);
    return { session, sink, name: worker, usageName: usageKey, model, reasoningEffort: effort };
  }

  async createReviewer(taskId, route = 'standard') {
    const safeTaskId = safeSessionPart(taskId);
    const sink = { value: null };
    const tool = createReviewTool(this.sdk.defineTool, sink);
    const model = this.models.reviewer;
    const desiredEffort = routePolicy(route).efforts.reviewer;
    const effort = chooseReasoningEffort(model, desiredEffort, this.reasoningMode);
    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-reviewer`,
      clientName: 'convergent-vscode',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [tool],
      systemMessage: { mode: 'append', content: REVIEWER_PROMPT },
      excludedTools: ['edit'],
      hooks: { onPreToolUse: readonlyHook },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));
    const usageKey = `${safeTaskId}:reviewer`;
    attachEventLogging(session, 'Strong reviewer', this.ui, this.usage, model, usageKey);
    return { session, sink, name: 'Strong reviewer', usageName: usageKey, model, reasoningEffort: effort };
  }
}

module.exports = { SessionFactory, readonlyHook, safeSessionPart, withReasoning };
