'use strict';

const { resolveModel, isAdaptiveWorkerSelector } = require('../orchestrator/model-resolver');

const ADAPTIVE_WORKER_PRESETS = {
  workerA: ['cheap-a', 'balanced-a', 'fast-a', 'high-risk-a'],
  workerB: ['cheap-b', 'balanced-b', 'fast-b', 'high-risk-b'],
};

function modelSummary(model) {
  return {
    id: model?.id ?? '',
    name: model?.name ?? '',
    billing: model?.billing,
    supportedReasoningEfforts: Array.isArray(model?.supportedReasoningEfforts)
      ? [...model.supportedReasoningEfforts]
      : undefined,
    defaultReasoningEffort: model?.defaultReasoningEffort,
    capabilities: model?.capabilities,
  };
}

function selectorRequiresPinnedModel(selector) {
  const normalized = String(selector ?? '').trim().toLowerCase();
  return Boolean(normalized && normalized !== 'auto');
}

function unresolvedIssue(role, selector, resolution, preset = null) {
  return {
    role,
    selector,
    preset,
    reason: resolution.reason,
  };
}

function resolveWorkerPolicy(role, selector, available, issues) {
  const normalized = String(selector ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'auto') return { selector, presets: [] };

  if (isAdaptiveWorkerSelector(normalized)) {
    const presets = ADAPTIVE_WORKER_PRESETS[role].map((preset) => {
      const resolution = resolveModel(preset, available);
      if (resolution.id === 'auto') {
        issues.push(unresolvedIssue(role, selector, resolution, preset));
      }
      return { preset, resolution };
    });
    return { selector, presets };
  }

  const resolution = resolveModel(selector, available);
  if (resolution.id === 'auto') issues.push(unresolvedIssue(role, selector, resolution));
  return { selector, resolution, presets: [] };
}

function resolveHeadlessRoleModels(options, available = []) {
  const coordinator = resolveModel(options.coordinator, available);
  const reviewer = resolveModel(options.reviewer, available);
  const issues = [];

  if (selectorRequiresPinnedModel(options.coordinator) && coordinator.id === 'auto') {
    issues.push(unresolvedIssue('coordinator', options.coordinator, coordinator));
  }
  if (selectorRequiresPinnedModel(options.reviewer) && reviewer.id === 'auto') {
    issues.push(unresolvedIssue('reviewer', options.reviewer, reviewer));
  }

  const workers = {
    workerA: resolveWorkerPolicy('workerA', options.workerA ?? 'adaptive', available, issues),
    workerB: resolveWorkerPolicy('workerB', options.workerB ?? 'adaptive-diverse', available, issues),
  };

  return {
    available: available.map(modelSummary),
    coordinator,
    reviewer,
    workers,
    issues,
  };
}

function assertHeadlessRoleModels(resolution) {
  if (!resolution?.issues?.length) return resolution;
  const detail = resolution.issues
    .map((issue) => {
      const preset = issue.preset ? ` via ${issue.preset}` : '';
      return `${issue.role} selector ${JSON.stringify(issue.selector)}${preset}: ${issue.reason}`;
    })
    .join('; ');
  const error = new Error(
    `Headless benchmark refused to start because required role-specific model selection degraded to Copilot auto: ${detail}. `
    + 'Inspect models.json/model preflight output or explicitly choose selector "auto" if automatic routing is intentional.',
  );
  error.code = 'CONVERGENT_HEADLESS_MODEL_POLICY';
  error.modelResolution = resolution;
  throw error;
}

module.exports = {
  ADAPTIVE_WORKER_PRESETS,
  modelSummary,
  selectorRequiresPinnedModel,
  resolveWorkerPolicy,
  resolveHeadlessRoleModels,
  assertHeadlessRoleModels,
};
