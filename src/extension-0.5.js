'use strict';

const vscode = require('vscode');
const {
  DEFAULT_REVIEW_ARCHITECTURE,
  REVIEW_ARCHITECTURES,
  normalizeReviewArchitecture,
} = require('./orchestrator/review-architecture');
const {
  CancellationBridge,
  ResponseStreamBridge,
  workflowInProgress,
  sendSteeringInstruction,
} = require('./ui/live-chat-control');

function installOverlay(baseRequest, overlayRequest) {
  const basePath = require.resolve(baseRequest);
  require(basePath);
  const overlay = require(overlayRequest);
  require.cache[basePath].exports = overlay;
}

// Install the 0.5 runtime overlays before loading any engine/session factory.
// This keeps the validated base implementation intact while correcting
// concurrent tool correlation, providing deterministic GitHub-host context,
// and turning task-change evidence into one shared reviewer packet.
installOverlay('./orchestrator/workspace-scope', './orchestrator/workspace-scope-0.5');
installOverlay('./orchestrator/task-change-manifest', './orchestrator/task-change-manifest-0.5');
installOverlay('./copilot/session-guard', './copilot/session-guard-0.5');
installOverlay('./copilot/run-command-tool', './copilot/run-command-tool-0.5');

// Install the 0.5 engine before loading the existing extension entrypoint. This
// keeps the validated 0.4 frontend/recovery implementation intact while swapping
// only the engine class consumed by extension.js.
const stablePath = require.resolve('./orchestrator/stable-chat-recovery');
const stableExports = require(stablePath);
const { ReviewArchitectureEngine } = require('./orchestrator/review-architecture-engine');
require.cache[stablePath].exports = {
  ...stableExports,
  StableChatRecoveryEngine: ReviewArchitectureEngine,
};

// Likewise, layer the 0.5 request/resume/task/review-cycle usage presentation on
// top of the validated base UI without duplicating the rest of the VS Code
// frontend implementation.
const vscodeUiPath = require.resolve('./ui/vscode-ui');
require(vscodeUiPath);
const vscodeUi05 = require('./ui/vscode-ui-0.5');
require.cache[vscodeUiPath].exports = vscodeUi05;

globalThis.__convergentReviewArchitectureProvider = () => vscode.workspace
  .getConfiguration('convergent')
  .get('reviewArchitecture', DEFAULT_REVIEW_ARCHITECTURE);

const extension = require('./extension');

let liveParticipantBridge = null;

function reviewArchitectureQuickPickItems() {
  return Object.values(REVIEW_ARCHITECTURES).map((architecture) => ({
    label: `${architecture.benchmarkId} · ${architecture.label}`,
    description: architecture.description,
    detail: architecture.id === DEFAULT_REVIEW_ARCHITECTURE ? 'Default in Convergent 0.5' : undefined,
    value: architecture.id,
  }));
}

async function selectReviewArchitecture() {
  const config = vscode.workspace.getConfiguration('convergent');
  const current = normalizeReviewArchitecture(config.get('reviewArchitecture', DEFAULT_REVIEW_ARCHITECTURE));
  const picked = await vscode.window.showQuickPick(reviewArchitectureQuickPickItems(), {
    title: 'Select Convergent review architecture',
    placeHolder: `Current: ${current.benchmarkId} · ${current.label}`,
  });
  if (!picked) return;
  await config.update('reviewArchitecture', picked.value, vscode.ConfigurationTarget.Workspace);
  const selected = normalizeReviewArchitecture(picked.value);
  vscode.window.showInformationMessage(
    `Convergent review architecture set to ${selected.benchmarkId} · ${selected.label}. New workflows use this setting; an already-running or resumed workflow keeps the architecture saved in its checkpoint.`,
  );
}

function safeResumeState() {
  try {
    return extension.loadResumeState();
  } catch {
    return null;
  }
}

function activeWorkflowEvidence() {
  const guards = extension.activeGuards();
  const state = safeResumeState();
  return {
    guards,
    state,
    active: workflowInProgress(guards, state),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSteeringGuards(bridge, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!bridge.settled && Date.now() < deadline) {
    const guards = extension.activeGuards();
    if (guards.length) return guards;
    if (!workflowInProgress(guards, safeResumeState())) return [];
    await delay(50);
  }
  return extension.activeGuards();
}

async function chooseSteeringGuard(guards) {
  if (!guards.length) return null;
  if (guards.length === 1) return guards[0];
  const picked = await vscode.window.showQuickPick(
    guards.map((guard) => ({ label: guard.agentName, guard })),
    { title: 'Steer active Convergent agent', placeHolder: 'Choose the active agent that should receive this instruction' },
  );
  return picked?.guard ?? null;
}

function renderManagedSteeringControl(stream, result) {
  const tool = result?.currentTool;
  if (!tool || !/(^|:)run[_-]?command$/i.test(String(tool.name ?? '')) || !tool.toolCallId) return;
  stream.markdown('\nThe managed command is still running. The steering instruction is queued for the agent; terminate the current command if you want Convergent to recover immediately and continue with this guidance.\n\n');
  if (typeof stream.button === 'function') {
    stream.button({
      command: 'convergent.terminateManagedCommand',
      title: 'Terminate command & recover with steering',
      arguments: [result.agent, tool.toolCallId, result.instruction],
    });
  }
}

async function steerLiveParticipant(bridge, request, stream, token) {
  bridge.adopt(token);
  bridge.responseStream?.adopt(stream);
  let guards = extension.activeGuards();

  const command = String(request?.command ?? '').toLowerCase();
  const instruction = String(request?.prompt ?? '').trim();
  if (command === 'resume' || /^\/?resume$/i.test(instruction)) {
    stream.markdown('**The Convergent workflow is already running.** This Chat response has adopted the live workflow instead of cancelling and restarting it.\n');
  } else if (instruction) {
    if (!guards.length) guards = await waitForSteeringGuards(bridge);
    const guard = await chooseSteeringGuard(guards);
    if (!guard) {
      stream.markdown('**Convergent kept the current workflow alive, but there is no active agent turn to steer at this instant.** The request was not started as a second workflow.\n');
    } else {
      const result = await sendSteeringInstruction(guard, instruction);
      if (!result.sent) {
        stream.markdown(`**Could not steer ${guard.agentName}:** ${result.reason}. The current workflow remains active.\n`);
      } else {
        guard.ui?.audit?.({
          type: 'operator_steer',
          agent: guard.agentName,
          instruction,
          source: 'chat_followup',
        });
        guard.ui?.log?.(`Operator steered ${guard.agentName} from a follow-up @convergent Chat message: ${instruction}`);
        stream.markdown(`↪ **Steering ${guard.agentName}:** ${instruction}\n`);
        renderManagedSteeringControl(stream, result);
      }
    }
  }

  const result = bridge.completion ? await bridge.completion : { metadata: { convergentKind: 'running', convergentFollowups: [] } };
  return result;
}

function wrapConvergentParticipant(handler) {
  return async (request, chatContext, stream, token) => {
    const current = liveParticipantBridge;
    if (current && !current.settled) {
      const evidence = activeWorkflowEvidence();
      if (evidence.active) {
        return steerLiveParticipant(current, request, stream, token);
      }
    }

    const bridge = new CancellationBridge();
    bridge.responseStream = new ResponseStreamBridge(stream);
    bridge.adopt(token);
    liveParticipantBridge = bridge;
    const completion = Promise.resolve(handler(request, chatContext, bridge.responseStream.proxy, bridge.token));
    bridge.setCompletion(completion);
    try {
      return await completion;
    } finally {
      bridge.markSettled();
      if (liveParticipantBridge === bridge) liveParticipantBridge = null;
    }
  };
}

function installLiveParticipantOverlay() {
  const chat = vscode.chat;
  const original = chat.createChatParticipant;
  chat.createChatParticipant = function createChatParticipant(id, handler) {
    const wrapped = id === 'convergent.workflow' ? wrapConvergentParticipant(handler) : handler;
    return original.call(this, id, wrapped);
  };
  return () => {
    chat.createChatParticipant = original;
  };
}

async function terminateManagedCommand(agentName, toolCallId, guidance = '') {
  const expectedAgent = String(agentName ?? '').trim();
  const expectedTool = String(toolCallId ?? '').trim();
  const guard = extension.activeGuards().find((candidate) => {
    if (expectedAgent && candidate.agentName !== expectedAgent) return false;
    const current = candidate.snapshot?.().currentTool;
    return current && /(^|:)run[_-]?command$/i.test(String(current.name ?? '')) && (!expectedTool || current.toolCallId === expectedTool);
  });
  if (!guard) {
    vscode.window.showInformationMessage('That managed-command control is stale; the referenced command is no longer active.');
    return false;
  }
  if (typeof guard.terminateCurrentManagedCommand !== 'function') {
    vscode.window.showErrorMessage('The active Convergent runtime cannot terminate this managed command independently.');
    return false;
  }

  const result = await guard.terminateCurrentManagedCommand(expectedTool, guidance);
  if (!result?.terminated) {
    vscode.window.showInformationMessage('The managed command changed or completed before termination could be applied.');
    return false;
  }
  const proven = result.termination?.proven;
  vscode.window.showInformationMessage(
    proven
      ? 'Managed command terminated with process-tree evidence. Convergent is recovering the agent turn.'
      : 'Managed command termination was requested, but process-tree termination could not be proven. Convergent will fail closed instead of starting another command.',
  );
  return true;
}

async function activate(context) {
  const restoreParticipant = installLiveParticipantOverlay();
  try {
    await extension.activate(context);
  } finally {
    restoreParticipant();
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('convergent.selectReviewArchitecture', selectReviewArchitecture),
    vscode.commands.registerCommand('convergent.terminateManagedCommand', terminateManagedCommand),
  );
}

async function deactivate() {
  liveParticipantBridge?.forwardNow?.();
  return extension.deactivate();
}

module.exports = {
  activate,
  deactivate,
  selectReviewArchitecture,
  reviewArchitectureQuickPickItems,
  wrapConvergentParticipant,
  steerLiveParticipant,
  terminateManagedCommand,
  installLiveParticipantOverlay,
};
