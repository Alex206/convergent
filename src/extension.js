'use strict';

const vscode = require('vscode');
const { ConvergentEngine } = require('./orchestrator/engine');
const { resolveModel } = require('./orchestrator/model-resolver');
const { createPermissionHandler, createUserInputHandler } = require('./copilot/permissions');
const { createClientOptions } = require('./copilot/runtime');
const { VscodeWorkflowUi } = require('./ui/vscode-ui');

let client;
let clientTransport;
let sdk;
let activeRun;
let output;

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

function readConfig() {
  const config = vscode.workspace.getConfiguration('convergent');
  return {
    selectors: {
      coordinator: config.get('models.coordinator', 'strong'),
      workerA: config.get('models.workerA', 'cheap-a'),
      workerB: config.get('models.workerB', 'cheap-b'),
      reviewer: config.get('models.reviewer', 'strong'),
    },
    maxWorkerPasses: config.get('maxWorkerPasses', 8),
    maxReviewerCycles: config.get('maxReviewerCycles', 3),
    agentTurnTimeoutMs: config.get('agentTurnTimeoutSeconds', 180) * 1000,
    permissionMode: config.get('permissionMode', 'workspace'),
    runtimeTransport: config.get('runtimeTransport', 'auto'),
  };
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
    output.appendLine(`${role}: ${model.name ?? model.id} (${model.id}) — ${model.reason}`);
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
    agentTurnTimeoutMs: config.agentTurnTimeoutMs,
    signal: controller.signal,
  });
  activeRun = { engine, controller };
  const cancellation = token.onCancellationRequested(() => {
    controller.abort();
    void engine.stop();
  });

  stream.button({ command: 'convergent.stop', title: 'Stop workflow' });
  stream.button({ command: 'convergent.showOutput', title: 'Show agent log' });

  try {
    await engine.run(prompt);
    stream.markdown('\n**Convergent finished successfully.** All planned tasks passed A/B convergence and the persistent strong reviewer.');
  } finally {
    cancellation.dispose();
    await engine.stop();
    activeRun = undefined;
  }
}

async function activate(context) {
  output = vscode.window.createOutputChannel('Convergent', { log: true });
  context.subscriptions.push(output);

  const participant = vscode.chat.createChatParticipant('convergent.workflow', async (request, _chatContext, stream, token) => {
    const prompt = request.prompt?.trim();
    if (!prompt) {
      stream.markdown('Describe the implementation task you want Convergent to plan, implement, cross-review, and quality-gate.');
      return;
    }
    try {
      await executeWorkflow(prompt, stream, token);
    } catch (error) {
      output.error(error?.stack ?? String(error));
      stream.markdown(`\n**Convergent stopped:** ${error.message ?? String(error)}`);
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
      await activeRun.engine.stop();
      vscode.window.showInformationMessage('Convergent workflow stopped.');
    }),
    vscode.commands.registerCommand('convergent.showOutput', () => output.show(true)),
    vscode.commands.registerCommand('convergent.showModels', async () => {
      try {
        const config = readConfig();
        const runtime = await getClient(config.runtimeTransport);
        const models = await runtime.client.listModels();
        output.show(true);
        output.appendLine('Available Copilot models:');
        for (const model of models) output.appendLine(`- ${model.name ?? model.id} [${model.id}]`);
      } catch (error) {
        vscode.window.showErrorMessage(`Could not list Copilot models: ${error.message ?? String(error)}`);
      }
    }),
  );
}

async function deactivate() {
  if (activeRun) await activeRun.engine.stop();
  if (client) await client.stop();
}

module.exports = { activate, deactivate, readConfig, resolveConfiguredModels, getClient };
