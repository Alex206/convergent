'use strict';

const {
  COORDINATOR_PROMPT,
  WORKER_A_PROMPT,
  WORKER_B_PROMPT,
  REVIEWER_PROMPT,
} = require('../orchestrator/prompts');
const { routePolicy, chooseReasoningEffort } = require('../orchestrator/routing');
const { resolveWorkerModel } = require('../orchestrator/model-resolver');
const { workerFlowInstructions, reviewerFlowInstructions, normalizeFlowMode } = require('../orchestrator/flow');
const { createPlanTool, createPassTool, createReviewTool, recoverSerializedReport } = require('./tools');
const { guardSession, describeToolCall } = require('./session-guard');

const SHELL_BUILTINS = process.platform === 'win32'
  ? ['builtin:powershell']
  : ['builtin:bash'];
const READ_BUILTINS = [
  'builtin:view',
  'builtin:glob',
  'builtin:rg',
  'builtin:grep',
  ...SHELL_BUILTINS,
];
const COORDINATOR_TOOLS = [
  ...READ_BUILTINS,
  'builtin:ask_user',
  'custom:report_plan',
];
const REVIEWER_TOOLS = [
  ...READ_BUILTINS,
  'custom:report_review',
];
const WORKER_TOOLS = [
  ...READ_BUILTINS,
  'builtin:apply_patch',
  'builtin:edit',
  'builtin:create',
  'custom:report_pass',
];

function shellText(input) {
  const args = input?.toolArgs ?? {};
  return [
    args.command,
    args.fullCommandText,
    args.script,
    args.input,
    JSON.stringify(args),
  ].filter(Boolean).join(' ');
}

function readonlyShellMutation(input) {
  const name = String(input?.toolName ?? '').toLowerCase();
  if (!/(bash|shell|powershell|terminal|cmd)/.test(name)) return false;
  const text = shellText(input);

  return /\bgit\s+(?:add|commit|push|pull|checkout|switch|reset|clean|restore|merge|rebase|cherry-pick|apply|am|rm|mv|stash)\b|\b(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Rename-Item)\b|(?:^|[;&|]\s*)\b(?:rm|mv|cp|mkdir|touch|truncate)\b|\bsed\s+-i\b|\bperl\s+-pi\b|\btee\b|(^|[^>])>\s*[^>&]|\bnpm\s+(?:install|update|uninstall)\b|\b(?:pip|uv\s+pip)\s+install\b/i.test(text);
}

function shellFileContentMutation(input) {
  const name = String(input?.toolName ?? '').toLowerCase();
  if (!/(bash|shell|powershell|terminal|cmd)/.test(name)) return false;
  const text = shellText(input);

  return /\b(?:Set-Content|Add-Content|Out-File)\b|\bsed\s+-i\b|\bperl\s+-pi\b|\btee\b|(^|[^>])>\s*[^>&]|\bapply_patch\b/i.test(text);
}

function readonlyHook(input) {
  const name = String(input.toolName ?? '').toLowerCase();
  if (/(^|[_-])(edit|write|delete|create|apply.?patch)($|[_-])/.test(name) || readonlyShellMutation(input)) {
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: 'This Convergent role is read-only; use inspection/diagnostic commands only.',
    };
  }
  return { permissionDecision: 'allow' };
}

function workerHook(input) {
  if (shellFileContentMutation(input)) {
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: 'Use the built-in apply_patch, edit, or create file tool instead of writing file content through the shell.',
    };
  }
  return { permissionDecision: 'allow' };
}

function safeSessionPart(value) {
  const part = String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (part || 'task').slice(0, 80);
}

function audit(ui, event) {
  try { void ui?.auditEvent?.(event); } catch {}
}

function attachOptional(session, eventName, handler, disposers) {
  try {
    const dispose = session.on(eventName, handler);
    if (dispose) disposers.push(dispose);
  } catch {
    // Compatible Copilot runtimes may not expose every optional event.
  }
}

function attachEventLogging(session, agentName, ui, usage, model, usageKey = agentName, reportFallback = null) {
  usage?.register(usageKey, session, model, agentName);
  const disposers = [];
  attachOptional(session, 'assistant.intent', (event) => {
    ui.agentIntent(agentName, event.data.intent);
    audit(ui, { type: 'assistant_intent', agent: agentName, sessionId: session.sessionId, data: event.data });
  }, disposers);
  attachOptional(session, 'tool.execution_start', (event) => {
    ui.agentTool(agentName, event.data.toolName, describeToolCall(event.data));
    audit(ui, { type: 'tool_start', agent: agentName, sessionId: session.sessionId, tool: event.data.toolName, data: event.data });
  }, disposers);
  attachOptional(session, 'tool.execution_partial_result', (event) => {
    audit(ui, { type: 'tool_partial_result', agent: agentName, sessionId: session.sessionId, data: event.data });
  }, disposers);
  attachOptional(session, 'tool.execution_complete', (event) => {
    audit(ui, { type: 'tool_complete', agent: agentName, sessionId: session.sessionId, tool: event.data.toolName, data: event.data });
  }, disposers);
  attachOptional(session, 'assistant.message', (event) => {
    const content = event.data.content;
    ui.agentMessage(agentName, content);
    audit(ui, { type: 'assistant_message', agent: agentName, sessionId: session.sessionId, content, data: event.data });
    if (reportFallback?.sink && !reportFallback.sink.value) {
      const recovered = recoverSerializedReport(content, reportFallback.toolName);
      if (recovered) {
        reportFallback.sink.value = recovered;
        ui.agentReportRecovered?.(agentName, reportFallback.toolName);
      }
    }
  }, disposers);
  attachOptional(session, 'assistant.turn_start', (event) => {
    audit(ui, { type: 'assistant_turn_start', agent: agentName, sessionId: session.sessionId, data: event.data });
  }, disposers);
  attachOptional(session, 'assistant.turn_end', (event) => {
    audit(ui, { type: 'assistant_turn_end', agent: agentName, sessionId: session.sessionId, data: event.data });
  }, disposers);
  attachOptional(session, 'assistant.usage', (event) => {
    usage?.recordAssistantUsage(usageKey, event.data);
    ui.agentUsageEvent?.(agentName, usage?.summary());
    audit(ui, { type: 'assistant_usage', agent: agentName, sessionId: session.sessionId, model: model?.id, data: event.data });
  }, disposers);
  attachOptional(session, 'session.usage_checkpoint', (event) => {
    usage?.recordCheckpoint(usageKey, event.data);
    ui.agentUsageEvent?.(agentName, usage?.summary());
    audit(ui, { type: 'usage_checkpoint', agent: agentName, sessionId: session.sessionId, data: event.data });
  }, disposers);
  attachOptional(session, 'session.usage_info', (event) => {
    usage?.recordContext(usageKey, event.data);
    audit(ui, { type: 'context_usage', agent: agentName, sessionId: session.sessionId, data: event.data });
  }, disposers);
  attachOptional(session, 'session.compaction_start', (event) => {
    audit(ui, { type: 'compaction_start', agent: agentName, sessionId: session.sessionId, data: event.data });
  }, disposers);
  attachOptional(session, 'session.compaction_end', (event) => {
    audit(ui, { type: 'compaction_end', agent: agentName, sessionId: session.sessionId, data: event.data });
  }, disposers);
  attachOptional(session, 'session.error', (event) => {
    ui.agentError(agentName, event.data.message);
    audit(ui, { type: 'session_error', agent: agentName, sessionId: session.sessionId, data: event.data });
  }, disposers);
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
    this.flowMode = normalizeFlowMode(models?.flowMode);
    this.taskWorkerModels = new Map();
  }

  guard(session, agentName) {
    return guardSession(session, agentName, this.ui, {
      toolStallTimeoutMs: this.ui?.toolStallTimeoutMs,
      agentInactivityTimeoutMs: this.ui?.agentInactivityTimeoutMs,
      stallGraceMs: this.ui?.stallGraceMs,
      heartbeatMs: this.ui?.heartbeatMs,
    });
  }

  workerModel(taskId, worker, route, risk) {
    const safeTaskId = safeSessionPart(taskId);
    const isA = worker === 'A';
    const selector = isA ? this.models.workerASelector : this.models.workerBSelector;
    const peer = this.taskWorkerModels.get(safeTaskId)?.A;
    const normalized = String(selector ?? '').trim().toLowerCase();
    const diversify = !isA && (normalized === 'adaptive' || normalized === 'adaptive-diverse' || normalized === 'cheap-b');
    const model = resolveWorkerModel(selector, this.models.available ?? [], {
      worker,
      route,
      risk,
      excludeIds: diversify && peer?.id ? [peer.id] : [],
    });
    const selected = this.taskWorkerModels.get(safeTaskId) ?? {};
    selected[worker] = model;
    this.taskWorkerModels.set(safeTaskId, selected);
    return model;
  }

  sessionCreated(agent, session, model, effort, systemPrompt, availableTools, extra = {}) {
    audit(this.ui, {
      type: 'session_create',
      agent,
      sessionId: session.sessionId,
      model: model?.id,
      modelName: model?.name,
      reasoningEffort: effort,
      flowMode: this.flowMode,
      systemPrompt,
      availableTools,
      ...extra,
    });
  }

  async createCoordinator() {
    const sink = { value: null };
    const tool = createPlanTool(this.sdk.defineTool, sink);
    const model = this.models.coordinator;
    const effort = chooseReasoningEffort(model, 'medium', this.reasoningMode);
    const systemPrompt = COORDINATOR_PROMPT;
    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-coordinator`,
      clientName: 'convergent-vscode',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [tool],
      availableTools: COORDINATOR_TOOLS,
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: { onPreToolUse: readonlyHook },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));
    const guard = this.guard(session, 'Coordinator');
    const usageKey = 'coordinator';
    attachEventLogging(session, 'Coordinator', this.ui, this.usage, model, usageKey);
    this.ui.agentTools?.('Coordinator', COORDINATOR_TOOLS);
    this.sessionCreated('Coordinator', session, model, effort, systemPrompt, COORDINATOR_TOOLS, { role: 'coordinator' });
    return { session, guard, sink, name: 'Coordinator', usageName: usageKey, model, reasoningEffort: effort };
  }

  async createWorker(taskId, worker, route = 'standard', risk = 'medium') {
    const safeTaskId = safeSessionPart(taskId);
    const sink = { value: null };
    const tool = createPassTool(this.sdk.defineTool, sink);
    const isA = worker === 'A';
    const role = isA ? 'workerA' : 'workerB';
    const model = this.workerModel(taskId, worker, route, risk);
    const desiredEffort = routePolicy(route, risk).efforts[role];
    const effort = chooseReasoningEffort(model, desiredEffort, this.reasoningMode);
    const flowInstructions = workerFlowInstructions(this.flowMode);
    const systemPrompt = [isA ? WORKER_A_PROMPT : WORKER_B_PROMPT, flowInstructions].filter(Boolean).join('\n\n');
    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-worker-${worker.toLowerCase()}`,
      clientName: 'convergent-vscode',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [tool],
      availableTools: WORKER_TOOLS,
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: { onPreToolUse: workerHook },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));
    const name = `Worker ${worker}`;
    const guard = this.guard(session, name);
    const usageKey = `${safeTaskId}:worker-${worker.toLowerCase()}`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey, { sink, toolName: 'report_pass' });
    this.ui.agentTools?.(name, WORKER_TOOLS);
    this.sessionCreated(name, session, model, effort, systemPrompt, WORKER_TOOLS, { role, taskId: safeTaskId, route, risk });
    return { session, guard, sink, name: worker, usageName: usageKey, model, reasoningEffort: effort };
  }

  async createReviewer(taskId, route = 'standard', risk = 'medium') {
    const safeTaskId = safeSessionPart(taskId);
    const sink = { value: null };
    const tool = createReviewTool(this.sdk.defineTool, sink);
    const model = this.models.reviewer;
    const desiredEffort = routePolicy(route, risk).efforts.reviewer;
    const effort = chooseReasoningEffort(model, desiredEffort, this.reasoningMode);
    const systemPrompt = [REVIEWER_PROMPT, reviewerFlowInstructions(this.flowMode)].filter(Boolean).join('\n\n');
    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-reviewer`,
      clientName: 'convergent-vscode',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [tool],
      availableTools: REVIEWER_TOOLS,
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: { onPreToolUse: readonlyHook },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));
    const guard = this.guard(session, 'Strong reviewer');
    const usageKey = `${safeTaskId}:reviewer`;
    attachEventLogging(session, 'Strong reviewer', this.ui, this.usage, model, usageKey, { sink, toolName: 'report_review' });
    this.ui.agentTools?.('Strong reviewer', REVIEWER_TOOLS);
    this.sessionCreated('Strong reviewer', session, model, effort, systemPrompt, REVIEWER_TOOLS, { role: 'reviewer', taskId: safeTaskId, route, risk });
    return { session, guard, sink, name: 'Strong reviewer', usageName: usageKey, model, reasoningEffort: effort };
  }
}

module.exports = {
  SessionFactory,
  attachEventLogging,
  readonlyHook,
  workerHook,
  readonlyShellMutation,
  shellFileContentMutation,
  safeSessionPart,
  withReasoning,
  SHELL_BUILTINS,
  COORDINATOR_TOOLS,
  REVIEWER_TOOLS,
  WORKER_TOOLS,
};
