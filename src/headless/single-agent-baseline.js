'use strict';

const { SessionFactory, attachEventLogging, workerHook, WORKER_TOOLS, withReasoning } = require('../copilot/session-factory');
const { chooseReasoningEffort } = require('../orchestrator/routing');
const { workspaceScopePrompt } = require('../orchestrator/workspace-scope');

const SINGLE_AGENT_TOOLS = WORKER_TOOLS.filter((tool) => tool !== 'custom:report_pass');

const SINGLE_AGENT_SYSTEM_PROMPT = `
You are the single-agent Terra baseline for a coding benchmark.

Work autonomously on the user's request until it is complete or genuinely impossible in the supplied environment.
Inspect only what is needed, edit the workspace directly, and run relevant validation.
Do not create unrelated changes, do not remove/revert pre-existing user workspace state merely to make Git status clean, and do not claim validation you did not run.
There is no coordinator, peer worker, Explore subagent, or independent reviewer. You alone own implementation and validation.
When the task is complete, stop. If an external prerequisite makes completion impossible, explain that in your final response and stop rather than inventing it.
`.trim();

async function runSingleAgentBaseline({
  client,
  sdk,
  workspace,
  workspaceFolders = null,
  models,
  permissionHandler,
  userInputHandler,
  ui,
  usage,
  runId,
  reasoningMode = 'adaptive',
  operatorCredentialGuard = null,
}) {
  const factory = new SessionFactory({
    client,
    sdk,
    workspace,
    workspaceFolders,
    models,
    permissionHandler,
    userInputHandler,
    ui,
    usage,
    runId,
    reasoningMode,
    operatorCredentialGuard,
  });

  const model = factory.workerModel('terra-solo', 'A', 'standard', 'medium');
  const effort = chooseReasoningEffort(model, 'medium', reasoningMode);
  const baselinePrompt = await factory.taskBaselinePrompt('terra-solo');
  const systemPrompt = [
    SINGLE_AGENT_SYSTEM_PROMPT,
    workspaceScopePrompt(workspace, factory.workspaceFolders),
    baselinePrompt,
  ].filter(Boolean).join('\n\n');

  let guard = null;
  const batchView = factory.batchViewTool();
  const runCommand = factory.runCommandTool('Terra solo', () => guard);
  const workspaceEdit = factory.workspaceEditTool('Terra solo');
  const session = await client.createSession(withReasoning({
    sessionId: `${runId}-terra-solo`,
    clientName: 'convergent-headless-topology',
    model: model.id,
    workingDirectory: workspace,
    streaming: true,
    tools: [batchView, runCommand, workspaceEdit],
    availableTools: SINGLE_AGENT_TOOLS,
    systemMessage: { mode: 'append', content: systemPrompt },
    hooks: {
      onPreToolUse: (input) => factory.preToolUse(workerHook, 'Terra solo', input),
    },
    onPermissionRequest: permissionHandler,
    onUserInputRequest: userInputHandler,
  }, effort));

  guard = factory.guard(session, 'Terra solo');
  const usageKey = 'terra-solo';
  attachEventLogging(session, 'Terra solo', ui, usage, model, usageKey);
  ui.agentTools?.('Terra solo', SINGLE_AGENT_TOOLS);
  factory.sessionCreated(
    'Terra solo',
    session,
    model,
    effort,
    systemPrompt,
    SINGLE_AGENT_TOOLS,
    { role: 'single-agent-baseline', benchmarkOnly: true },
  );
  ui.agentConfiguration?.([
    { role: 'Terra solo', model: model.name ?? model.id, effort },
  ]);

  return {
    session,
    usageKey,
    model,
    effort,
    async run(prompt) {
      const startedAt = Date.now();
      await session.sendAndWait({ prompt });
      usage.recordTurn(usageKey, Date.now() - startedAt);
      await usage.refresh(usageKey, session);
      return {
        usage: usage.summary(),
        stats: {
          tasks: 1,
          trivial: 0,
          full: 0,
          readOnly: 0,
          escalations: 0,
          baseline: 'terra-solo',
        },
      };
    },
    async stop() {
      await session.abort?.().catch(() => {});
      await session.disconnect?.().catch(() => {});
    },
  };
}

module.exports = {
  SINGLE_AGENT_TOOLS,
  SINGLE_AGENT_SYSTEM_PROMPT,
  runSingleAgentBaseline,
};