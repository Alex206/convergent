'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const packageJson = require('../package.json');
const { RecoveryConvergentEngine } = require('./orchestrator/recovery-engine');
const { resolveModel } = require('./orchestrator/model-resolver');
const { ensureConcreteUserRequest } = require('./orchestrator/request-preflight');
const { normalizeResumeState, resumeSummary } = require('./orchestrator/resume');
const { workspaceRevision } = require('./orchestrator/revision');
const { isWorkflowPausedError } = require('./orchestrator/control');
const { TrajectoryAudit } = require('./orchestrator/audit');
const { normalizeFlowMode, flowPolicy } = require('./orchestrator/flow');
const { createPermissionHandler, createUserInputHandler } = require('./copilot/permissions');
const { createClientOptions } = require('./copilot/runtime');
const { VscodeWorkflowUi, compactUsage, detailedUsageMarkdown, diagnosticsMarkdown } = require('./ui/vscode-ui');

const RESUME_STATE_KEY = 'convergent.resumeState.v1';
const FLOW_COMMANDS = new Set(['fast', 'auto', 'thorough']);
const EXTENSION_VERSION = packageJson.version;

let client;
let clientTransport;
let sdk;
let activeRun;
let lastUsage;
let lastDiagnostics;
let lastAuditDir;
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
      workerA: config.get('models.workerA', 'adaptive'),
      workerB: config.get('models.workerB', 'adaptive-diverse'),
      reviewer: config.get('models.reviewer', 'strong'),
    },
    flowMode: normalizeFlowMode(config.get('flow', 'auto')),
    routingMode: config.get('routingMode', 'adaptive'),
    reasoningMode: config.get('reasoningMode', 'adaptive'),
    maxWorkerPasses: config.get('maxWorkerPasses', 8),
    maxReviewerCycles: config.get('maxReviewerCycles', 3),
    maxAiCredits: config.get('maxAiCredits', 0),
    taskCommitMode: config.get('taskCommits', 'off'),
    agentInactivityTimeoutMs: agentInactivityTimeoutSeconds(config) * 1000,
    toolStallTimeoutMs: config.get('toolStallTimeoutSeconds', 120) * 1000,
    stallGraceMs: config.get('toolStallGraceSeconds', 10) * 1000,
    heartbeatMs: config.get('heartbeatSeconds', 30) * 1000,
    permissionMode: config.get('permissionMode', 'workspace'),
    runtimeTransport: config.get('runtimeTransport', 'auto'),
    audit: {
      enabled: config.get('audit.enabled', true),
      level: config.get('audit.level', 'metadata'),
      maxRuns: config.get('audit.maxRuns', 10),
      maxSizeMB: config.get('audit.maxSizeMB', 250),
      maxAgeDays: config.get('audit.maxAgeDays', 14),
    },
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

function loadResumeState(workspace = workspacePath()) {
  const value = extensionContext?.workspaceState.get(RESUME_STATE_KEY);
  return normalizeResumeState(value, workspace);
}

function tryLoadResumeState() {
  try {
    return loadResumeState();
  } catch {
    return null;
  }
}

async function persistResumeState(state) {
  await extensionContext?.workspaceState.update(RESUME_STATE_KEY, state);
}

async function clearResumeState() {
  await extensionContext?.workspaceState.update(RESUME_STATE_KEY, undefined);
}

async function markResumeInterrupted(state, reason) {
  if (!state || state.status === 'complete') return;
  await persistResumeState({
    ...state,
    status: 'interrupted',
    interruptedAt: new Date().toISOString(),
    interruptionReason: reason,
  });
}

async function confirmBoundaryResume(state, workspace) {
  if (!state?.plan || !state?.revision || state.currentTaskIndex !== null) return true;
  let current;
  try {
    current = await workspaceRevision(workspace);
  } catch {
    return true;
  }
  if (current === state.revision) return true;
  const answer = await vscode.window.showWarningMessage(
    'The workspace changed after Convergent’s last completed-task checkpoint. Resuming will keep the current workspace and continue with the saved next task.',
    { modal: true },
    'Resume with current workspace',
  );
  return answer === 'Resume with current workspace';
}

async function resolveConfiguredModels(copilotClient, selectors, flowMode = 'auto') {
  let available = [];
  try {
    available = await copilotClient.listModels();
  } catch (error) {
    output.appendLine(`Could not list Copilot models; presets fall back to auto: ${error.message}`);
  }

  const coordinator = resolveModel(selectors.coordinator, available);
  const reviewer = resolveModel(selectors.reviewer, available);
  const resolved = {
    coordinator,
    reviewer,
    workerASelector: selectors.workerA,
    workerBSelector: selectors.workerB,
    available,
    flowMode: normalizeFlowMode(flowMode),
  };

  for (const [role, model] of Object.entries({ coordinator, reviewer })) {
    const efforts = model.supportedReasoningEfforts?.length ? `; reasoning=${model.supportedReasoningEfforts.join('/')}` : '';
    output.appendLine(`${role}: ${model.name ?? model.id} (${model.id}) — ${model.reason}${efforts}`);
  }
  output.appendLine(`workerA policy: ${selectors.workerA} — resolved per task after route/risk classification`);
  output.appendLine(`workerB policy: ${selectors.workerB} — resolved per task after route/risk classification; adaptive-diverse/cheap-b avoid Worker A when possible`);
  return resolved;
}

function auditRoot() {
  return path.join(extensionContext.globalStorageUri.fsPath, 'audit');
}

async function latestAuditDirectory() {
  if (lastAuditDir) return lastAuditDir;
  let entries;
  try { entries = await fs.readdir(auditRoot(), { withFileTypes: true }); } catch { return null; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(auditRoot(), entry.name);
    try { candidates.push({ directory, mtimeMs: (await fs.stat(directory)).mtimeMs }); } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.directory ?? null;
}

function activeGuards() {
  return (activeRun?.engine?.sessions ?? [])
    .map((session) => session?.__convergentGuard)
    .filter((guard) => guard && guard.activeRejectors?.size > 0);
}

async function steerActiveAgent() {
  if (!activeRun) {
    vscode.window.showInformationMessage('No Convergent workflow is running.');
    return;
  }
  const guards = activeGuards();
  if (!guards.length) {
    vscode.window.showInformationMessage('No Convergent agent turn is currently active.');
    return;
  }
  let guard = guards[0];
  if (guards.length > 1) {
    const picked = await vscode.window.showQuickPick(
      guards.map((item) => ({ label: item.agentName, guard: item })),
      { title: 'Steer active Convergent agent', placeHolder: 'Choose the agent to steer' },
    );
    if (!picked) return;
    guard = picked.guard;
  }
  const instruction = await vscode.window.showInputBox({
    title: `Steer ${guard.agentName}`,
    prompt: 'Instruction is injected into the active Copilot turn before its next model step. It does not restart the task.',
    placeHolder: 'Example: Stop broad exploration; review only the current diff and finish the pass.',
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) return;
  if (typeof guard.rawSend !== 'function') {
    vscode.window.showErrorMessage('The active Copilot session does not expose immediate steering.');
    return;
  }
  await activeRun.audit?.record({ type: 'operator_steer', agent: guard.agentName, instruction });
  await guard.rawSend({
    prompt: `Operator steering instruction from the user: ${instruction.trim()}`,
    mode: 'immediate',
  });
  output.appendLine(`[${new Date().toISOString()}] Operator steered ${guard.agentName}: ${instruction.trim()}`);
  vscode.window.showInformationMessage(`Steering instruction sent to ${guard.agentName}.`);
}

async function executeWorkflow(prompt, stream, token, resumeState = null, flowOverride = null) {
  if (activeRun) throw new Error('A Convergent workflow is already running. Stop it before starting another one.');
  const workspace = workspacePath();
  const config = readConfig();
  const flow = flowPolicy(flowOverride ?? resumeState?.flowMode ?? config.flowMode, config);
  const runtime = await getClient(config.runtimeTransport);
  const models = await resolveConfiguredModels(runtime.client, config.selectors, flow.mode);
  const controller = new AbortController();
  const audit = new TrajectoryAudit({
    rootDir: auditRoot(),
    ...config.audit,
  });
  const auditRunId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
  lastAuditDir = await audit.start({
    runId: auditRunId,
    convergentVersion: EXTENSION_VERSION,
    workspace,
    flowMode: flow.mode,
    flowPolicy: flow,
    request: prompt,
    runtimeTransport: runtime.transport,
    modelSelectors: config.selectors,
  });

  const ui = new VscodeWorkflowUi(vscode, stream, output, {
    workspace,
    version: EXTENSION_VERSION,
    flowMode: flow.mode,
    eventSink: (event) => audit.record(event),
  });
  ui.agentInactivityTimeoutMs = config.agentInactivityTimeoutMs;
  ui.toolStallTimeoutMs = config.toolStallTimeoutMs;
  ui.stallGraceMs = config.stallGraceMs;
  ui.heartbeatMs = config.heartbeatMs;
  ui.runStarted({ version: EXTENSION_VERSION, flowMode: flow.mode, flowLabel: flow.label });
  stream.progress(`Flow: ${flow.label} — ${flow.description}`);
  output.appendLine(`[${new Date().toISOString()}] Convergent ${EXTENSION_VERSION}; flow=${flow.mode}; worker tranche=${flow.maxWorkerPasses}; reviewer tranche=${flow.maxReviewerCycles}; reviewer scope=${flow.reviewerScope}`);

  let latestCheckpoint = resumeState;
  let runStatus = 'failed';
  let runError = null;
  const engine = new RecoveryConvergentEngine({
    client: runtime.client,
    sdk: runtime.sdk,
    workspace,
    models,
    permissionHandler: createPermissionHandler(vscode, workspace, config.permissionMode, output),
    userInputHandler: createUserInputHandler(vscode),
    ui,
    maxWorkerPasses: flow.maxWorkerPasses,
    maxReviewerCycles: flow.maxReviewerCycles,
    maxAiCredits: config.maxAiCredits,
    taskCommitMode: config.taskCommitMode,
    routingMode: config.routingMode,
    reasoningMode: config.reasoningMode,
    signal: controller.signal,
    onCheckpoint: async (state) => {
      const enriched = { ...state, flowMode: flow.mode };
      latestCheckpoint = enriched;
      if (activeRun?.engine === engine) activeRun.latestCheckpoint = enriched;
      await persistResumeState(enriched);
      await audit.record({ type: 'checkpoint', state: enriched });
      output.appendLine(`[${new Date().toISOString()}] Resume checkpoint: stage=${state.stage}; nextTask=${state.nextTaskIndex}; currentTask=${state.currentTaskIndex ?? 'none'}`);
    },
  });
  activeRun = { engine, controller, latestCheckpoint, audit, flow, version: EXTENSION_VERSION };
  const cancellation = token.onCancellationRequested(() => {
    controller.abort();
    void audit.record({ type: 'operator_cancel', reason: 'Chat request cancelled by user.' });
    void markResumeInterrupted(activeRun?.latestCheckpoint, 'Chat request cancelled by user.');
    void engine.stop();
  });

  stream.button({ command: 'convergent.stop', title: 'Stop workflow' });
  stream.button({ command: 'convergent.steer', title: 'Steer active agent' });
  stream.button({ command: 'convergent.showUsage', title: 'Show usage' });
  stream.button({ command: 'convergent.showDiagnostics', title: 'Show diagnostics' });
  stream.button({ command: 'convergent.showOutput', title: 'Show agent log' });
  stream.button({ command: 'convergent.openLastAudit', title: 'Open audit' });
  stream.button({ command: 'workbench.view.scm', title: 'Source Control' });

  try {
    const result = await engine.run(prompt, resumeState);
    lastUsage = result.usage;
    await clearResumeState();
    runStatus = 'complete';
    stream.markdown(`\n**Convergent ${EXTENSION_VERSION} finished successfully.**`);
  } catch (error) {
    runError = error?.message ?? String(error);
    await audit.record({ type: 'run_error', error: runError, stack: error?.stack });
    await markResumeInterrupted(latestCheckpoint, runError);
    if (isWorkflowPausedError(error)) {
      runStatus = 'paused';
      ui.workflowPaused(error.message ?? 'Paused at a configured soft limit.');
      return;
    }
    throw error;
  } finally {
    cancellation.dispose();
    lastUsage = engine.getUsageSummary();
    await persistDiagnostics(collectDiagnostics(engine));
    await audit.finish({ status: runStatus, usage: lastUsage, stats: engine.stats, error: runError });
    await engine.stop();
    activeRun = undefined;
  }
}

async function activate(context) {
  extensionContext = context;
  lastDiagnostics = context.globalState.get('convergent.lastDiagnostics');
  output = vscode.window.createOutputChannel('Convergent', { log: true });
  context.subscriptions.push(output);
  output.appendLine(`Convergent ${EXTENSION_VERSION} activated (VS Code ${vscode.version}; host ${process.execPath}).`);

  const participant = vscode.chat.createChatParticipant('convergent.workflow', async (request, _chatContext, stream, token) => {
    let prompt = request.prompt?.trim();
    const command = String(request.command ?? '').toLowerCase();
    const flowOverride = FLOW_COMMANDS.has(command) ? command : null;
    const prefix = /^\/(fast|auto|thorough)\b\s*/i.exec(prompt ?? '');
    if (!flowOverride && prefix) prompt = prompt.slice(prefix[0].length).trim();
    const explicitFlow = flowOverride ?? (prefix ? prefix[1].toLowerCase() : null);
    const wantsResume = command === 'resume' || prompt === '/resume' || /^resume$/i.test(prompt ?? '');
    try {
      if (wantsResume) {
        const workspace = workspacePath();
        const state = loadResumeState(workspace);
        if (!state) {
          stream.markdown(`**Convergent ${EXTENSION_VERSION}**\n\nThere is no resumable Convergent workflow for this workspace.`);
          return;
        }
        if (!(await confirmBoundaryResume(state, workspace))) {
          stream.markdown('Resume cancelled. The saved checkpoint was kept.');
          return;
        }
        stream.markdown(`**Resuming previous Convergent workflow.** ${resumeSummary(state)}\n`);
        await executeWorkflow(state.request, stream, token, state, explicitFlow ?? state.flowMode);
        return;
      }

      if (!prompt) {
        stream.markdown(`**Convergent ${EXTENSION_VERSION}**\n\nDescribe what you want Convergent to inspect or implement. Use \`/fast\`, \`/auto\`, or \`/thorough\` to choose the assurance/speed profile for this run.`);
        const state = tryLoadResumeState();
        if (state) stream.markdown(`\nA previous workflow can also be resumed with \`@convergent /resume\`. ${resumeSummary(state)}`);
        return;
      }

      const preflight = await ensureConcreteUserRequest(
        prompt,
        createUserInputHandler(vscode),
        (message) => {
          output.appendLine(`[${new Date().toISOString()}] Request preflight: ${message}`);
          stream.progress('The referenced request is missing; waiting for you to paste it.');
        },
      );
      await executeWorkflow(preflight.request, stream, token, null, explicitFlow);
    } catch (error) {
      output.error(error?.stack ?? String(error));
      if (error?.convergentDiagnostic) output.appendLine(`Control diagnostic: ${JSON.stringify(error.convergentDiagnostic)}`);
      stream.markdown(`\n**Convergent ${EXTENSION_VERSION} stopped:** ${error.message ?? String(error)}`);
      if (error?.code === 'CONVERGENT_TOOL_STALL' || error?.code === 'CONVERGENT_AGENT_INACTIVITY') {
        stream.markdown('\nThe watchdog cancelled a stalled agent turn. Use **Show diagnostics** for the captured tool/runtime state.');
      }
      const state = tryLoadResumeState();
      if (state) {
        stream.markdown(`\nA resume checkpoint was kept. ${resumeSummary(state)}`);
        stream.button({ command: 'convergent.resume', title: 'Resume workflow' });
      }
    }
  });
  participant.iconPath = new vscode.ThemeIcon('git-merge');
  context.subscriptions.push(participant);

  context.subscriptions.push(
    vscode.commands.registerCommand('convergent.start', async () => {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@convergent ' });
    }),
    vscode.commands.registerCommand('convergent.resume', async () => {
      if (activeRun) {
        vscode.window.showWarningMessage('A Convergent workflow is already running.');
        return;
      }
      const state = tryLoadResumeState();
      if (!state) {
        vscode.window.showInformationMessage('No resumable Convergent workflow is available for this workspace.');
        return;
      }
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@convergent /resume' });
    }),
    vscode.commands.registerCommand('convergent.stop', async () => {
      if (!activeRun) {
        vscode.window.showInformationMessage('No Convergent workflow is running.');
        return;
      }
      activeRun.controller.abort();
      await activeRun.audit?.record({ type: 'operator_stop' });
      await markResumeInterrupted(activeRun.latestCheckpoint, 'Stopped by user.');
      void activeRun.engine.stop();
      vscode.window.showInformationMessage('Convergent cancellation requested. A resume checkpoint was kept so the saved request or current task can be continued safely.');
    }),
    vscode.commands.registerCommand('convergent.steer', steerActiveAgent),
    vscode.commands.registerCommand('convergent.selectFlow', async () => {
      const picked = await vscode.window.showQuickPick([
        { label: 'Fast', description: 'Focused review; ask sooner before more iterations', value: 'fast' },
        { label: 'Auto', description: 'Balanced adaptive workflow', value: 'auto' },
        { label: 'Thorough', description: 'Broader assurance and larger autonomous review tranches', value: 'thorough' },
      ], { title: 'Select default Convergent flow' });
      if (!picked) return;
      await vscode.workspace.getConfiguration('convergent').update('flow', picked.value, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(`Convergent default flow set to ${picked.label}. You can override one run with @convergent /fast, /auto, or /thorough.`);
    }),
    vscode.commands.registerCommand('convergent.openLastAudit', async () => {
      const directory = await latestAuditDirectory();
      if (!directory) {
        vscode.window.showInformationMessage('No Convergent trajectory audit is available yet.');
        return;
      }
      const summary = path.join(directory, 'summary.json');
      const events = path.join(directory, 'events.jsonl');
      let target = summary;
      try { await fs.access(summary); } catch { target = events; }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      await vscode.window.showTextDocument(document, { preview: false });
    }),
    vscode.commands.registerCommand('convergent.revealLastAudit', async () => {
      const directory = await latestAuditDirectory();
      if (!directory) {
        vscode.window.showInformationMessage('No Convergent trajectory audit is available yet.');
        return;
      }
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(directory));
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
      output.appendLine(`Convergent ${EXTENSION_VERSION} usage snapshot`);
      output.appendLine(detailedUsageMarkdown(usage));
      vscode.window.showInformationMessage(`Convergent ${EXTENSION_VERSION} usage: ${compactUsage(usage)}`);
    }),
    vscode.commands.registerCommand('convergent.showDiagnostics', async () => {
      const diagnostics = activeRun ? collectDiagnostics(activeRun.engine) : lastDiagnostics;
      if (!diagnostics?.length) {
        vscode.window.showInformationMessage(`No Convergent ${EXTENSION_VERSION} diagnostics are available yet.`);
        return;
      }
      output.show(true);
      output.appendLine('');
      output.appendLine(`Convergent ${EXTENSION_VERSION} diagnostics snapshot`);
      output.appendLine(diagnosticsMarkdown(diagnostics, { version: EXTENSION_VERSION }));
      output.appendLine(JSON.stringify({ convergentVersion: EXTENSION_VERSION, agents: diagnostics }, null, 2));
      vscode.window.showInformationMessage(`Convergent ${EXTENSION_VERSION} diagnostics written to the Convergent output channel.`);
    }),
    vscode.commands.registerCommand('convergent.showModels', async () => {
      try {
        const config = readConfig();
        const runtime = await getClient(config.runtimeTransport);
        const models = await runtime.client.listModels();
        output.show(true);
        output.appendLine(`Available Copilot models for Convergent ${EXTENSION_VERSION}:`);
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
    await activeRun.audit?.record({ type: 'extension_deactivate' }).catch(() => {});
    await markResumeInterrupted(activeRun.latestCheckpoint, 'VS Code extension deactivated.').catch(() => {});
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
  loadResumeState,
  persistResumeState,
  markResumeInterrupted,
  latestAuditDirectory,
  activeGuards,
  EXTENSION_VERSION,
};
