'use strict';

const vscode = require('vscode');
const {
  DEFAULT_REVIEW_ARCHITECTURE,
  REVIEW_ARCHITECTURES,
  normalizeReviewArchitecture,
} = require('./orchestrator/review-architecture');

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
