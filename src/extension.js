'use strict';

const vscode = require('vscode');
const { ConvergentEngine } = require('./orchestrator/engine');
const { resolveModel } = require('./orchestrator/model-resolver');
const { ensureConcreteUserRequest } = require('./orchestrator/request-preflight');
const { createPermissionHandler, createUserInputHandler } = require('./copilot/permissions');
const { createClientOptions } = require('./copilot/runtime');
const { VscodeWorkflowUi, compactUsage, detailedUsageMarkdown, diagnosticsMarkdown } = require('./ui/vscode-ui');

let client;
let clientTransport;
let sdk;
let activeRun;
let lastUsage;
let lastDiagnostics;
let output;
let extensionContext;

async function getClient(requestedTransport = 'auto') {
  if (!sdk) sdk = await import('@github/copilot-sdk');

  const runtime = createClientOptions(sdk, requestedTransport, process.execPath);

  if (client && clientTransport !== runtime.transport) {
    await client.stop();
    client = undefined;
    clientTransport = undefined;
  }

  if (!client) {
    output?.appendLine(`Copilot runtime transport: ${runtime.transport} (host executable: ${process.execPath})`);
    const nextClient = new sdk.CopilotClient(runtime.options);
    try {
      await nextClient.start();
    } catch (error) {
      await nextClient.stop().catch(() => {});
      throw error;
    }
    client = nextClient;
    clientTransport = runtime.transport;
  }

  return { client, sdk, transport: clientTransport };
}

function workspacePath() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) throw new Error('Open a Git repository workspace before starting Convergent.');
  if (folders.length > 1) {
    const active = vscode.window.activeTextEditor?.document?.uri;
    const folder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    if (folder) return folder.uri.fsPath;
  }
  return folders[0].uri.fsPath;
}

function explicitConfigValue(config, key) {
  const inspected = config.inspect?.(key);
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

function agentInactivityTimeoutSeconds(config) {
  const current = explicitConfigValue(config, 'agentInactivityTimeoutSeconds');
  if (current !== undefined) return Number(current);
  const legacy = explicitConfigValue(config, 'agentTurnTimeoutSeconds');
  if (legacy !== undefined) return Number(legacy);
  return Number(config.get('agentInactivityTimeoutSeconds', 180));
}

function readConfig() {
  const config = vscode.workspace.getConfiguration('convergent');
  return {
    selectors: {
      coordinator: config.get('models.coordinator', 'strong'),
      workerA: config.get('models.workerA', 'cheap-a'),
      workerB: config.get('models.workerB', 'cheap-b'),
      reviewer: config.get('models.reviewer', 'strong'),
    },
    routingMode: config.get('routingMode', 'adaptive'),
    reasoningMode: config.get('reasoningMode', 'adaptive'),
    maxWorkerPasses: config.get('maxWorkerPasses', 8),
    maxReviewerCycles: config.get('maxReviewerCycles', 3),
    agentInactivityTimeoutMs: agentInactivityTimeoutSeconds(config) * 1000,
    toolStallTimeoutMs: config.get('toolStallTimeoutSeconds', 120) * 1000,
    stallGraceMs: config.get('toolStallGraceSeconds', 10) * 1000,
    heartbeatMs: config.get('heartbeatSeconds', 30) * 1000,
    permissionMode: config.get('permissionMode', 'workspace'),
    runtimeTransport: config.get('runtimeTransport', 'auto'),
  };
}

function collectDiagnostics(engine) {
  return (engine?.sessions ?? [])
    .map((session) => session?.__convergentGuard?.snapshot?.())
    .filter(Boolean);
}

async function persistDiagnostics(diagnostics) {
  lastDiagnostics = diagnostics;
  try {
    await extensionContext?.globalState.update('convergent.lastDiagnostics', diagnostics);
  } catch (error) {
    output?.appendLine(`Could not persist Convergent diagnostics: ${error.message ?? String(error)}`);
  }
}

async function resolveConfiguredModels(copilotClient, selectors) {
  let available = [];
  try {
    available = await copilotClient.listModels();
  } catch (error) {
    output.appendLine(`Could not list Copilot models; presets fall back to auto: ${error.message}`);
  }

  const coordinator = resolveModel(selectors.coordinator, available);
  const workerA = resolveModel(selectors.workerA, available);
  const workerBSelector = String(selectors.workerB ?? '').trim().toLowerCase();
  const workerB = resolveModel(
    selectors.workerB,
    available,
    workerBSelector === 'cheap-b' ? { excludeIds: [workerA.id] } : {},
  );
  const reviewer = resolveModel(selectors.reviewer, available);
  const resolved = { coordinator, workerA, workerB, reviewer };

  for (const [role, model] of Object.entries(resolved)) {
    const efforts = model.supportedReasoningEfforts?.length ? `; reasoning=${model.supportedReasoningEfforts.join('/')}` : '';
    output.appendLine(`${role}: ${model.name ?? model.id} (${model.id}) — ${model.reason}${efforts}`);
  }
  if (workerA.id !== 'auto' && workerA.id === workerB.id) {
    output.appendLine('Warning: Worker A and Worker B resolved to the same model. Configure convergent.models.workerB explicitly if you want model-family diversity.');
  }
  return resolved;
}

async function executeWorkflow(prompt, stream, token) {
  if (activeRun) throw new Error('A Convergent workflow is already running. Stop it before starting another one.');
  const workspace = workspacePath();
  const config = readConfig();
  const runtime = await getClient(config.runtimeTransport);
  const models = await resolveConfiguredModels(runtime.client, config.selectors);
  const controller = new AbortController();
  const ui = new VscodeWorkflowUi(vscode, stream, output);
  ui.agentInactivityTimeoutMs = config.agentInactivityTimeoutMs;
  ui.toolStallTimeoutMs = config.toolStallTimeoutMs;
  ui.stallGraceMs = config.stallGraceMs;
  ui.heartbeatMs = config.heartbeatMs;

  const engine = new ConvergentEngine({
    client: runtime.client,
    sdk: runtime.sdk,
    workspace,
    models,
    permissionHandler: createPermissionHandler(vscode, workspace, config.permissionMode, output),
    userInputHandler: createUserInputHandler(vscode),
    ui,
    maxWorkerPasses: config.maxWorkerPasses,
    maxReviewerCycles: config.maxReviewerCycles,
    routingMode: config.routingMode,
    reasoningMode: config.reasoningMode,
    signal: controller.signal,
  });
  activeRun = { engine, controller };
  const cancellation = token.onCancellationRequested(() => {
    controller.abort();
    void engine.stop();
  });

  stream.button({ command: 'convergent.stop', title: 'Stop workflow' });
  stream.button({ command: 'convergent.showUsage', title: 'Show usage' });
  stream.button({ command: 'convergent.showDiagnostics', title: 'Show diagnostics' });
  stream.button({ command: 'convergent.showOutput', title: 'Show agent log' });
  stream.button({ command: 'workbench.view.scm', title: 'Source Control' });

  try {
    const result = await engine.run(prompt);
    lastUsage = result.usage;
    stream.markdown('\n**Convergent finished successfully.**');
  } finally {
    cancellation.dispose();
    lastUsage = engine.getUsageSummary();
    await persistDiagnostics(collectDiagnostics(engine));
    await engine.stop();
    activeRun = undefined;
  }
}

async function activate(context) {
  extensionContext = context;
  lastDiagnostics = context.globalState.get('convergent.lastDiagnostics');
  output = vscode.window.createOutputChannel('Convergent', { log: true });
  context.subscriptions.push(output);

  const participant = vscode.chat.createChatParticipant('convergent.workflow', async (request, _chatContext, stream, token) => {
    const prompt = request.prompt?.trim();
    if (!prompt) {
      stream.markdown('Describe what you want Convergent to inspect or implement. The persistent strong coordinator will understand, clarify, plan, and classify the request before execution.');
      return;
    }
    try {
      const preflight = await ensureConcreteUserRequest(
        prompt,
        createUserInputHandler(vscode),
        (message) => {
          output.appendLine(`[${new Date().toISOString()}] Request preflight: ${message}`);
          stream.progress('The referenced request is missing; waiting for you to paste it.');
        },
      );
      await executeWorkflow(preflight.request, stream, token);
    } catch (error) {
      output.error(error?.stack ?? String(error));
      if (error?.convergentDiagnostic) output.appendLine(`Control diagnostic: ${JSON.stringify(error.convergentDiagnostic)}`);
      stream.markdown(`\n**Convergent stopped:** ${error.message ?? String(error)}`);
      if (error?.code === 'CONVERGENT_TOOL_STALL' || error?.code === 'CONVERGENT_AGENT_INACTIVITY') {
        stream.markdown('\nThe watchdog cancelled a stalled agent turn. Use **Show diagnostics** for the captured tool/runtime state.');
      }
    }
  });
  participant.iconPath = new vscode.ThemeIcon('git-merge');
  context.subscriptions.push(participant);

  context.subscriptions.push(
    vscode.commands.registerCommand('convergent.start', async () => {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@convergent ' });
    }),
    vscode.commands.registerCommand('convergent.stop', async () => {
      if (!activeRun) {
        vscode.window.showInformationMessage('No Convergent workflow is running.');
        return;
      }
      activeRun.controller.abort();
      void activeRun.engine.stop();
      vscode.window.showInformationMessage('Convergent cancellation requested. The UI will not wait indefinitely for an unresponsive SDK session.');
    }),
    vscode.commands.registerCommand('convergent.showOutput', () => output.show(true)),
    vscode.commands.registerCommand('convergent.showUsage', async () => {
      const usage = activeRun?.engine.getUsageSummary() ?? lastUsage;
      if (!usage) {
        vscode.window.showInformationMessage('No Convergent usage data is available yet.');
        return;
      }
      output.show(true);
      output.appendLine('');
      output.appendLine('Convergent usage snapshot');
      output.appendLine(detailedUsageMarkdown(usage));
      vscode.window.showInformationMessage(`Convergent usage: ${compactUsage(usage)}`);
    }),
    vscode.commands.registerCommand('convergent.showDiagnostics', async () => {
      const diagnostics = activeRun ? collectDiagnostics(activeRun.engine) : lastDiagnostics;
      if (!diagnostics?.length) {
        vscode.window.showInformationMessage('No Convergent diagnostics are available yet.');
        return;
      }
      output.show(true);
      output.appendLine('');
      output.appendLine('Convergent diagnostics snapshot');
      output.appendLine(diagnosticsMarkdown(diagnostics));
      output.appendLine(JSON.stringify(diagnostics, null, 2));
      vscode.window.showInformationMessage('Convergent diagnostics written to the Convergent output channel.');
    }),
    vscode.commands.registerCommand('convergent.showModels', async () => {
      try {
        const config = readConfig();
        const runtime = await getClient(config.runtimeTransport);
        const models = await runtime.client.listModels();
        output.show(true);
        output.appendLine('Available Copilot models:');
        for (const model of models) {
          const efforts = model.supportedReasoningEfforts?.length ? `; reasoning=${model.supportedReasoningEfforts.join('/')}` : '';
          output.appendLine(`- ${model.name ?? model.id} [${model.id}]${efforts}`);
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Could not list Copilot models: ${error.message ?? String(error)}`);
      }
    }),
  );
}

async function deactivate() {
  if (activeRun) {
    activeRun.controller.abort();
    void activeRun.engine.stop();
  }
  if (client) await client.stop();
}

module.exports = {
  activate,
  deactivate,
  readConfig,
  resolveConfiguredModels,
  getClient,
  collectDiagnostics,
  explicitConfigValue,
  agentInactivityTimeoutSeconds,
};
