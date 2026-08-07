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
    for (const pattern of patterns) {
      const match = eligible.find((model) => pattern.test(modelText(model)));
      if (match) {
        const diversified = excludedIds.size > 0 ? '; diversified from peer worker' : '';
        return { id: match.id, name: match.name, reason: `${normalized} preset${diversified}` };
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
