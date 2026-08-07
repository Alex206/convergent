'use strict';

const {
  COORDINATOR_PROMPT,
  WORKER_A_PROMPT,
  WORKER_B_PROMPT,
  REVIEWER_PROMPT,
} = require('../orchestrator/prompts');
const { createPlanTool, createPassTool, createReviewTool } = require('./tools');

function readonlyHook(input) {
  const name = String(input.toolName ?? '').toLowerCase();
  if (/(^|[_-])(edit|write|delete|create|apply.?patch)($|[_-])/.test(name)) {
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: 'This Convergent role is read-only.',
    };
  }
  if (name === 'shell' || name === 'bash' || name === 'powershell') {
    return {
      permissionDecision: 'ask',
      permissionDecisionReason: 'This Convergent role is read-only; approve this shell command only if it cannot modify source files.',
    };
  }
  return { permissionDecision: 'allow' };
}

function safeSessionPart(value) {
  const part = String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (part || 'task').slice(0, 80);
}

function attachEventLogging(session, agentName, ui) {
  const disposers = [];
  disposers.push(
    session.on('assistant.intent', (event) => ui.agentIntent(agentName, event.data.intent)),
    session.on('tool.execution_start', (event) => ui.agentTool(agentName, event.data.toolName)),
    session.on('assistant.message', (event) => ui.agentMessage(agentName, event.data.content)),
    session.on('session.error', (event) => ui.agentError(agentName, event.data.message)),
  );
  return () => disposers.forEach((dispose) => dispose?.());
}

class SessionFactory {
  constructor({ client, sdk, workspace, models, permissionHandler, userInputHandler, ui, runId }) {
    this.client = client;
    this.sdk = sdk;
    this.workspace = workspace;
    this.models = models;
    this.permissionHandler = permissionHandler;
    this.userInputHandler = userInputHandler;
    this.ui = ui;
    this.runId = runId;
  }

  async createCoordinator() {
    const sink = { value: null };
    const tool = createPlanTool(this.sdk.defineTool, sink);
    const session = await this.client.createSession({
      sessionId: `${this.runId}-coordinator`,
      clientName: 'convergent-vscode',
      model: this.models.coordinator.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [tool],
      systemMessage: { mode: 'append', content: COORDINATOR_PROMPT },
      excludedTools: ['edit'],
      hooks: { onPreToolUse: readonlyHook },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    });
    attachEventLogging(session, 'Coordinator', this.ui);
    return { session, sink };
  }

  async createWorker(taskId, worker) {
    const safeTaskId = safeSessionPart(taskId);
    const sink = { value: null };
    const tool = createPassTool(this.sdk.defineTool, sink);
    const isA = worker === 'A';
    const session = await this.client.createSession({
      sessionId: `${this.runId}-${safeTaskId}-worker-${worker.toLowerCase()}`,
      clientName: 'convergent-vscode',
      model: isA ? this.models.workerA.id : this.models.workerB.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [tool],
      systemMessage: { mode: 'append', content: isA ? WORKER_A_PROMPT : WORKER_B_PROMPT },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    });
    attachEventLogging(session, `Worker ${worker}`, this.ui);
    return { session, sink, name: worker };
  }

  async createReviewer(taskId) {
    const safeTaskId = safeSessionPart(taskId);
    const sink = { value: null };
    const tool = createReviewTool(this.sdk.defineTool, sink);
    const session = await this.client.createSession({
      sessionId: `${this.runId}-${safeTaskId}-reviewer`,
      clientName: 'convergent-vscode',
      model: this.models.reviewer.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [tool],
      systemMessage: { mode: 'append', content: REVIEWER_PROMPT },
      excludedTools: ['edit'],
      hooks: { onPreToolUse: readonlyHook },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    });
    attachEventLogging(session, 'Strong reviewer', this.ui);
    return { session, sink };
  }
}

module.exports = { SessionFactory, readonlyHook, safeSessionPart };
