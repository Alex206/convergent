'use strict';

const {
  COORDINATOR_PROMPT,
  WORKER_A_PROMPT,
  WORKER_B_PROMPT,
  REVIEWER_PROMPT,
} = require('../orchestrator/prompts');
const { routePolicy, chooseReasoningEffort } = require('../orchestrator/routing');
const { createPlanTool, createPassTool, createReviewTool, recoverSerializedReport } = require('./tools');
const { guardSession } = require('./session-guard');

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

function attachEventLogging(session, agentName, ui, usage, model, usageKey = agentName, reportFallback = null) {
  usage?.register(usageKey, session, model, agentName);
  const disposers = [];
  disposers.push(
    session.on('assistant.intent', (event) => ui.agentIntent(agentName, event.data.intent)),
    session.on('tool.execution_start', (event) => ui.agentTool(agentName, event.data.toolName)),
    session.on('assistant.message', (event) => {
      const content = event.data.content;
      ui.agentMessage(agentName, content);
      if (reportFallback?.sink && !reportFallback.sink.value) {
        const recovered = recoverSerializedReport(content, reportFallback.toolName);
        if (recovered) {
          reportFallback.sink.value = recovered;
          ui.agentReportRecovered?.(agentName, reportFallback.toolName);
        }
      }
    }),
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

  guard(session, agentName) {
    return guardSession(session, agentName, this.ui, {
      toolStallTimeoutMs: this.ui?.toolStallTimeoutMs,
      agentInactivityTimeoutMs: this.ui?.agentInactivityTimeoutMs,
      stallGraceMs: this.ui?.stallGraceMs,
      heartbeatMs: this.ui?.heartbeatMs,
    });
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
      availableTools: COORDINATOR_TOOLS,
      systemMessage: { mode: 'append', content: COORDINATOR_PROMPT },
      hooks: { onPreToolUse: readonlyHook },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));
    const guard = this.guard(session, 'Coordinator');
    const usageKey = 'coordinator';
    attachEventLogging(session, 'Coordinator', this.ui, this.usage, model, usageKey);
    this.ui.agentTools?.('Coordinator', COORDINATOR_TOOLS);
    return { session, guard, sink, name: 'Coordinator', usageName: usageKey, model, reasoningEffort: effort };
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
      availableTools: WORKER_TOOLS,
      systemMessage: { mode: 'append', content: isA ? WORKER_A_PROMPT : WORKER_B_PROMPT },
      hooks: { onPreToolUse: workerHook },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));
    const name = `Worker ${worker}`;
    const guard = this.guard(session, name);
    const usageKey = `${safeTaskId}:worker-${worker.toLowerCase()}`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey, { sink, toolName: 'report_pass' });
    this.ui.agentTools?.(name, WORKER_TOOLS);
    return { session, guard, sink, name: worker, usageName: usageKey, model, reasoningEffort: effort };
  }

  async createReviewer(taskId, route = 'standard', risk = 'medium') {
    const safeTaskId = safeSessionPart(taskId);
    const sink = { value: null };
    const tool = createReviewTool(this.sdk.defineTool, sink);
    const model = this.models.reviewer;
    const desiredEffort = routePolicy(route, risk).efforts.reviewer;
    const effort = chooseReasoningEffort(model, desiredEffort, this.reasoningMode);
    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-reviewer`,
      clientName: 'convergent-vscode',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [tool],
      availableTools: REVIEWER_TOOLS,
      systemMessage: { mode: 'append', content: REVIEWER_PROMPT },
      hooks: { onPreToolUse: readonlyHook },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));
    const guard = this.guard(session, 'Strong reviewer');
    const usageKey = `${safeTaskId}:reviewer`;
    attachEventLogging(session, 'Strong reviewer', this.ui, this.usage, model, usageKey, { sink, toolName: 'report_review' });
    this.ui.agentTools?.('Strong reviewer', REVIEWER_TOOLS);
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
