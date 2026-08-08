'use strict';

const PRESETS = {
  strong: [
    /gpt[- ]?5\.6.*sol/i,
    /gpt[- ]?5\.6/i,
    /gpt[- ]?5\.5/i,
    /gpt[- ]?5\.4(?!.*mini|.*nano)/i,
    /claude.*sonnet.*5/i,
    /claude.*sonnet.*4\.6/i,
    /gemini.*3\.1.*pro/i,
    /claude.*sonnet/i,
    /gemini.*pro/i,
  ],
  planner: [
    /gpt[- ]?5\.6.*luna/i,
    /gpt[- ]?5\.4.*mini/i,
    /gpt[- ]?5.*mini/i,
    /claude.*haiku.*4\.5/i,
    /gemini.*\b3(?:\.0)?\b(?!\.\d).*flash/i,
  ],
  'cheap-a': [
    /gpt[- ]?5\.6.*luna/i,
    /claude.*haiku.*4\.5/i,
    /gpt[- ]?5\.4.*nano/i,
    /gpt[- ]?5\.4.*mini/i,
    /gpt[- ]?5.*mini/i,
    /raptor.*mini/i,
  ],
  'cheap-b': [
    /gemini.*\b3(?:\.0)?\b(?!\.\d).*flash/i,
    /gpt[- ]?5\.4.*nano/i,
    /gpt[- ]?5\.4.*mini/i,
    /gpt[- ]?5.*mini/i,
    /raptor.*mini/i,
    /claude.*haiku.*4\.5/i,
  ],
  'balanced-a': [
    /gpt[- ]?5\.6.*luna/i,
    /gpt[- ]?5\.4.*mini/i,
    /gpt[- ]?5.*mini/i,
    /gpt[- ]?5\.6.*terra/i,
    /claude.*sonnet.*5/i,
    /claude.*haiku.*4\.5/i,
    /gemini.*\b3(?:\.0)?\b(?!\.\d).*flash/i,
  ],
  'balanced-b': [
    /gpt[- ]?5\.4.*mini/i,
    /gpt[- ]?5.*mini/i,
    /gpt[- ]?5\.6.*luna/i,
    /gemini.*\b3(?:\.0)?\b(?!\.\d).*flash/i,
    /gpt[- ]?5\.6.*terra/i,
    /claude.*sonnet.*5/i,
    /claude.*haiku.*4\.5/i,
  ],
  'fast-a': [
    /gpt[- ]?5\.6.*terra/i,
    /claude.*sonnet.*5/i,
    /gpt[- ]?5\.6.*sol/i,
    /gpt[- ]?5\.5/i,
    /gpt[- ]?5\.4(?!.*mini|.*nano)/i,
    /gpt[- ]?5\.6.*luna/i,
    /gpt[- ]?5\.4.*mini/i,
    /gpt[- ]?5.*mini/i,
    /claude.*haiku.*4\.5/i,
  ],
  'fast-b': [
    /gpt[- ]?5\.4.*mini/i,
    /gpt[- ]?5.*mini/i,
    /gpt[- ]?5\.6.*luna/i,
    /gpt[- ]?5\.6.*terra/i,
    /claude.*sonnet.*5/i,
    /gemini.*\b3(?:\.0)?\b(?!\.\d).*flash/i,
    /claude.*haiku.*4\.5/i,
  ],
  'high-risk-a': [
    /gpt[- ]?5\.6.*terra/i,
    /claude.*sonnet.*5/i,
    /gpt[- ]?5\.6.*sol/i,
    /gpt[- ]?5\.5/i,
    /gpt[- ]?5\.4(?!.*mini|.*nano)/i,
    /claude.*sonnet.*4\.6/i,
    /claude.*sonnet/i,
    /gpt[- ]?5\.4.*mini/i,
    /gpt[- ]?5.*mini/i,
  ],
  'high-risk-b': [
    /gpt[- ]?5\.4.*mini/i,
    /gpt[- ]?5.*mini/i,
    /gpt[- ]?5\.6.*terra/i,
    /claude.*sonnet.*5/i,
    /gpt[- ]?5\.6.*sol/i,
    /gpt[- ]?5\.5/i,
    /gpt[- ]?5\.4(?!.*mini|.*nano)/i,
    /gpt[- ]?5\.6.*luna/i,
    /claude.*sonnet/i,
    /claude.*haiku.*4\.5/i,
  ],
};

function modelText(model) {
  return `${model?.id ?? ''} ${model?.name ?? ''}`.trim();
}

function firstPresetMatch(patterns, models) {
  for (const pattern of patterns) {
    const match = models.find((model) => pattern.test(modelText(model)));
    if (match) return match;
  }
  return undefined;
}

function resolvedModel(model, reason) {
  if (!model) return { id: 'auto', reason };
  return {
    id: model.id,
    name: model.name,
    reason,
    supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
      ? [...model.supportedReasoningEfforts]
      : undefined,
    defaultReasoningEffort: model.defaultReasoningEffort,
    billing: model.billing,
    capabilities: model.capabilities,
  };
}

function resolveModel(selector, models = [], options = {}) {
  const excludedIds = new Set((options.excludeIds ?? []).filter(Boolean).map((id) => String(id).toLowerCase()));
  const eligible = models.filter((model) => !excludedIds.has(String(model?.id ?? '').toLowerCase()));

  if (!selector || selector.toLowerCase() === 'auto') {
    return { id: 'auto', reason: 'automatic model selection' };
  }

  const normalized = selector.trim().toLowerCase();
  const exact = models.find(
    (model) => model?.id?.toLowerCase() === normalized || model?.name?.toLowerCase() === normalized,
  );
  if (exact) return resolvedModel(exact, 'exact configured model');

  const patterns = PRESETS[normalized];
  if (patterns) {
    const diversified = firstPresetMatch(patterns, eligible);
    if (diversified) {
      const suffix = excludedIds.size > 0 ? '; diversified from peer worker' : '';
      return resolvedModel(diversified, `${normalized} preset${suffix}`);
    }

    if (excludedIds.size > 0) {
      const sameModel = firstPresetMatch(patterns, models);
      if (sameModel) {
        return resolvedModel(sameModel, `${normalized} preset; no different matching model available`);
      }
    }

    return { id: 'auto', reason: `${normalized} preset had no available match; falling back to auto` };
  }

  const fuzzy = models.find((model) => modelText(model).toLowerCase().includes(normalized));
  if (fuzzy) return resolvedModel(fuzzy, 'fuzzy configured model match');

  return { id: 'auto', reason: `configured selector "${selector}" was unavailable; falling back to auto` };
}

function adaptivePreset(worker, route = 'standard', risk = 'medium', flowMode = 'auto') {
  const role = String(worker ?? 'A').toUpperCase() === 'B' ? 'b' : 'a';
  const flow = String(flowMode ?? 'auto').toLowerCase();
  if (route === 'high_risk' || risk === 'high') return `high-risk-${role}`;
  if (route === 'trivial' && risk === 'low') return `cheap-${role}`;
  // Fast is about shortest accepted-result trajectory, not automatically the
  // strongest/most expensive worker. Low-risk standard work already has tight
  // scope and benefits more from fewer agent-loop round trips than model
  // promotion; medium-risk Fast work can still promote capability.
  if (flow === 'fast' && risk !== 'low') return `fast-${role}`;
  return `balanced-${role}`;
}

function isAdaptiveWorkerSelector(selector) {
  const normalized = String(selector ?? '').trim().toLowerCase();
  return normalized === 'adaptive' || normalized === 'adaptive-diverse';
}

function resolveWorkerModel(selector, models = [], options = {}) {
  const worker = String(options.worker ?? 'A').toUpperCase() === 'B' ? 'B' : 'A';
  const normalized = String(selector ?? '').trim().toLowerCase();
  if (!isAdaptiveWorkerSelector(normalized)) {
    return resolveModel(selector, models, { excludeIds: options.excludeIds });
  }

  const preset = adaptivePreset(worker, options.route, options.risk, options.flowMode);
  const result = resolveModel(preset, models, { excludeIds: options.excludeIds });
  return {
    ...result,
    reason: `adaptive Worker ${worker}: flow=${options.flowMode ?? 'auto'}, route=${options.route ?? 'standard'}, risk=${options.risk ?? 'medium'} -> ${preset}; ${result.reason}`,
  };
}

module.exports = {
  resolveModel,
  resolveWorkerModel,
  adaptivePreset,
  isAdaptiveWorkerSelector,
  PRESETS,
  resolvedModel,
};