'use strict';

const { assertGitRepository } = require('../orchestrator/revision');
const { resolveModel } = require('../orchestrator/model-resolver');
const { ConvergentEngine } = require('../orchestrator/engine');
const { attachEventLogging } = require('../copilot/session-factory');
const { guardSession } = require('../copilot/session-guard');

function defaultCopilotSessionConfig({
  runId,
  workspace,
  selector = 'auto',
  available = [],
  permissionHandler,
  userInputHandler,
}) {
  const normalized = String(selector ?? 'auto').trim().toLowerCase();
  const resolution = resolveModel(selector, available);
  const config = {
    sessionId: `${runId}-copilot-default`,
    clientName: 'convergent-architecture-benchmark-default-copilot',
    workingDirectory: workspace,
    streaming: true,
    onPermissionRequest: permissionHandler,
    onUserInputRequest: userInputHandler,
  };

  // For the genuine default/Auto baseline, omit `model` entirely so the SDK/CLI
  // owns its ordinary automatic model choice. Explicit/preset variants set only
  // the model while still preserving the default CLI persona and built-in tools.
  if (normalized && normalized !== 'auto') config.model = resolution.id;

  return { config, resolution };
}

class DefaultCopilotEngine extends ConvergentEngine {
  constructor(options = {}) {
    super(options);
    this.selector = options.defaultAgentSelector ?? 'auto';
  }

  async run(userRequest) {
    await assertGitRepository(this.workspace);
    this.checkCancelled();

    const { config, resolution } = defaultCopilotSessionConfig({
      runId: this.runId,
      workspace: this.workspace,
      selector: this.selector,
      available: this.models?.available ?? [],
      permissionHandler: this.permissionHandler,
      userInputHandler: this.userInputHandler,
    });
    if (String(this.selector).trim().toLowerCase() !== 'auto' && resolution.id === 'auto') {
      throw new Error(`Default Copilot benchmark selector ${JSON.stringify(this.selector)} could not resolve explicitly.`);
    }

    const session = await this.client.createSession(config);
    this.sessions.push(session);
    const agentName = 'Default Copilot agent';
    const usageName = 'default-copilot';
    const requestedModel = config.model
      ? { ...resolution }
      : { id: 'auto', name: 'Copilot default/Auto' };
    const guard = guardSession(session, agentName, this.ui, {
      toolStallTimeoutMs: this.ui?.toolStallTimeoutMs,
      agentInactivityTimeoutMs: this.ui?.agentInactivityTimeoutMs,
      stallGraceMs: this.ui?.stallGraceMs,
      heartbeatMs: this.ui?.heartbeatMs,
    });
    const guardedSendAndWait = session.sendAndWait.bind(session);
    session.sendAndWait = (options, timeoutMs) => {
      try {
        void this.ui?.auditEvent?.({
          type: 'prompt_send',
          agent: agentName,
          sessionId: session.sessionId,
          prompt: options?.prompt,
          mode: options?.mode ?? 'normal',
        });
      } catch {}
      return guardedSendAndWait(options, timeoutMs);
    };
    attachEventLogging(session, agentName, this.ui, this.usage, requestedModel, usageName);
    this.ui?.auditEvent?.({
      type: 'session_create',
      agent: agentName,
      role: 'default-agent',
      sessionId: session.sessionId,
      model: config.model ?? 'auto',
      modelName: requestedModel.name,
      reasoningEffort: null,
      systemPrompt: null,
      availableTools: null,
      customTools: false,
      defaultCopilotPersona: true,
    });
    this.ui?.agentConfiguration?.([
      {
        role: 'Default Copilot agent',
        model: config.model ? (resolution.name ?? resolution.id) : 'Copilot default/Auto',
        effort: null,
      },
    ]);
    this.stats.tasks = 1;
    this.stats.full = 1;
    this.stats.architecture = 'copilot-default';
    this.ui?.phase?.(
      'Default Copilot baseline',
      'Running one ordinary Copilot SDK agent session without Convergent role prompts, custom tools, tool allowlists, or hooks.',
    );

    const startedAt = Date.now();
    let finalMessage;
    try {
      finalMessage = await session.sendAndWait({ prompt: userRequest }, this.agentTurnTimeoutMs);
      await this.finishTurn({ session, guard, usageName }, startedAt);
      const usage = this.getUsageSummary();
      this.ui?.phase?.('Complete', 'Default Copilot baseline reached session.idle.');
      this.ui?.runSummary?.(usage, this.stats);
      return {
        architecture: 'copilot-default',
        finalMessage: finalMessage?.data?.content ?? finalMessage?.content ?? null,
        requestedModel: config.model ?? null,
        usage,
        stats: { ...this.stats },
      };
    } finally {
      guard?.dispose?.();
    }
  }
}

module.exports = {
  defaultCopilotSessionConfig,
  DefaultCopilotEngine,
};
