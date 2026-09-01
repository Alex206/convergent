'use strict';

const vscode = require('vscode');
const {
  DEFAULT_REVIEW_ARCHITECTURE,
  REVIEW_ARCHITECTURES,
  normalizeReviewArchitecture,
} = require('./orchestrator/review-architecture');

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

async function activate(context) {
  await extension.activate(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('convergent.selectReviewArchitecture', selectReviewArchitecture),
  );
}

async function deactivate() {
  return extension.deactivate();
}

module.exports = {
  activate,
  deactivate,
  selectReviewArchitecture,
  reviewArchitectureQuickPickItems,
};
