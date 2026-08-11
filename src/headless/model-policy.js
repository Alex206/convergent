'use strict';

const { resolveModel } = require('../orchestrator/model-resolver');

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

function resolveHeadlessRoleModels(options, available = []) {
  const coordinator = resolveModel(options.coordinator, available);
  const reviewer = resolveModel(options.reviewer, available);
  const issues = [];

  if (selectorRequiresPinnedModel(options.coordinator) && coordinator.id === 'auto') {
    issues.push({
      role: 'coordinator',
      selector: options.coordinator,
      reason: coordinator.reason,
    });
  }
  if (selectorRequiresPinnedModel(options.reviewer) && reviewer.id === 'auto') {
    issues.push({
      role: 'reviewer',
      selector: options.reviewer,
      reason: reviewer.reason,
    });
  }

  return {
    available: available.map(modelSummary),
    coordinator,
    reviewer,
    issues,
  };
}

function assertHeadlessRoleModels(resolution) {
  if (!resolution?.issues?.length) return resolution;
  const detail = resolution.issues
    .map((issue) => `${issue.role} selector ${JSON.stringify(issue.selector)}: ${issue.reason}`)
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
  modelSummary,
  selectorRequiresPinnedModel,
  resolveHeadlessRoleModels,
  assertHeadlessRoleModels,
};
