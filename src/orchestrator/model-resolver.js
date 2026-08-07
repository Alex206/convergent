'use strict';

const PRESETS = {
  strong: [
    /gpt[- ]?5\.6.*sol/i,
    /gpt[- ]?5\.6/i,
    /gpt[- ]?5\.5/i,
    /gpt[- ]?5\.4(?!.*mini|.*nano)/i,
    /claude.*sonnet.*4\.6/i,
    /gemini.*3\.1.*pro/i,
    /claude.*sonnet/i,
    /gemini.*pro/i,
  ],
  'cheap-a': [
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
  if (exact) {
    return { id: exact.id, name: exact.name, reason: 'exact configured model' };
  }

  const patterns = PRESETS[normalized];
  if (patterns) {
    const diversified = firstPresetMatch(patterns, eligible);
    if (diversified) {
      const suffix = excludedIds.size > 0 ? '; diversified from peer worker' : '';
      return { id: diversified.id, name: diversified.name, reason: `${normalized} preset${suffix}` };
    }

    // Diversity is desirable, but cost predictability is more important. If the
    // only available preset match is the peer worker's model, reuse it rather than
    // falling through to Copilot auto (which may choose a more expensive model).
    if (excludedIds.size > 0) {
      const sameCheapModel = firstPresetMatch(patterns, models);
      if (sameCheapModel) {
        return {
          id: sameCheapModel.id,
          name: sameCheapModel.name,
          reason: `${normalized} preset; no different cheap model available`,
        };
      }
    }

    return { id: 'auto', reason: `${normalized} preset had no available match; falling back to auto` };
  }

  const fuzzy = models.find((model) => modelText(model).toLowerCase().includes(normalized));
  if (fuzzy) {
    return { id: fuzzy.id, name: fuzzy.name, reason: 'fuzzy configured model match' };
  }

  return { id: 'auto', reason: `configured selector "${selector}" was unavailable; falling back to auto` };
}

module.exports = { resolveModel, PRESETS };
