'use strict';

const LIMITS = Object.freeze({
  maxAiCredits: { min: 0, max: 100000 },
  maxReviewerCycles: { min: 1, max: 20, integer: true },
  maxWorkerPasses: { min: 2, max: 30, integer: true },
});

const OPTION_DEFINITIONS = Object.freeze([
  { names: ['credits', 'ai-credits'], key: 'maxAiCredits' },
  { names: ['review-cycles', 'reviewer-cycles'], key: 'maxReviewerCycles' },
  { names: ['worker-passes'], key: 'maxWorkerPasses' },
]);

function optionPattern(names) {
  return new RegExp(`^\\s*--(?:${names.join('|')})(?:=|\\s+)([^\\s]+)(?:\\s+|$)`, 'i');
}

function parseBoundedNumber(raw, key, optionName) {
  const spec = LIMITS[key];
  const value = Number(raw);
  if (!Number.isFinite(value) || (spec.integer && !Number.isInteger(value)) || value < spec.min || value > spec.max) {
    const type = spec.integer ? 'integer' : 'number';
    throw new Error(`Invalid ${optionName} value ${JSON.stringify(raw)}. Expected a ${type} from ${spec.min} to ${spec.max}.`);
  }
  return value;
}

function parseRunOptions(prompt) {
  let request = String(prompt ?? '').trim();
  const limits = {};

  while (request.startsWith('--')) {
    let matched = false;
    for (const definition of OPTION_DEFINITIONS) {
      const pattern = optionPattern(definition.names);
      const match = pattern.exec(request);
      if (!match) continue;
      const optionName = `--${definition.names[0]}`;
      limits[definition.key] = parseBoundedNumber(match[1], definition.key, optionName);
      request = request.slice(match[0].length).trimStart();
      matched = true;
      break;
    }
    if (!matched) break;
  }

  return { request: request.trim(), limits };
}

function hasRunLimitOverrides(limits) {
  return Object.values(limits ?? {}).some((value) => value !== undefined);
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function checkpointRunLimits(engine, fallback = {}) {
  if (!engine) {
    const maxWorkerPasses = Math.max(2, Math.floor(finiteOr(fallback.maxWorkerPasses, 8)));
    const maxReviewerCycles = Math.max(1, Math.floor(finiteOr(fallback.maxReviewerCycles, 3)));
    const maxAiCredits = Math.max(0, finiteOr(fallback.maxAiCredits, 0));
    const aiCreditIncrement = Math.max(0, finiteOr(fallback.aiCreditIncrement, maxAiCredits));
    return {
      maxWorkerPasses,
      maxReviewerCycles,
      maxAiCredits,
      aiCreditIncrement,
      aiCreditCeiling: maxAiCredits > 0 ? maxAiCredits : null,
      aiCreditsUnlimited: maxAiCredits <= 0,
    };
  }

  return {
    maxWorkerPasses: Math.max(2, Math.floor(finiteOr(engine.maxWorkerPasses, fallback.maxWorkerPasses ?? 8))),
    maxReviewerCycles: Math.max(1, Math.floor(finiteOr(engine.maxReviewerCycles, fallback.maxReviewerCycles ?? 3))),
    maxAiCredits: Math.max(0, finiteOr(engine.maxAiCredits, fallback.maxAiCredits ?? 0)),
    aiCreditIncrement: Math.max(0, finiteOr(engine.aiCreditIncrement, fallback.aiCreditIncrement ?? engine.maxAiCredits ?? 0)),
    aiCreditCeiling: Number.isFinite(engine.aiCreditCeiling) ? Math.max(0, Number(engine.aiCreditCeiling)) : null,
    aiCreditsUnlimited: !Number.isFinite(engine.aiCreditCeiling),
  };
}

function restoreRunLimits(engine, saved) {
  if (!engine || !saved || typeof saved !== 'object') return;
  if (Number.isFinite(Number(saved.maxWorkerPasses))) {
    engine.maxWorkerPasses = Math.max(2, Math.floor(Number(saved.maxWorkerPasses)));
  }
  if (Number.isFinite(Number(saved.maxReviewerCycles))) {
    engine.maxReviewerCycles = Math.max(1, Math.floor(Number(saved.maxReviewerCycles)));
  }
  if (Number.isFinite(Number(saved.maxAiCredits))) {
    engine.maxAiCredits = Math.max(0, Number(saved.maxAiCredits));
  }
  if (Number.isFinite(Number(saved.aiCreditIncrement))) {
    engine.aiCreditIncrement = Math.max(0, Number(saved.aiCreditIncrement));
  } else {
    engine.aiCreditIncrement = engine.maxAiCredits;
  }
  if (saved.aiCreditsUnlimited) {
    engine.aiCreditCeiling = Number.POSITIVE_INFINITY;
  } else if (Number.isFinite(Number(saved.aiCreditCeiling))) {
    engine.aiCreditCeiling = Math.max(0, Number(saved.aiCreditCeiling));
  } else {
    engine.aiCreditCeiling = engine.maxAiCredits > 0 ? engine.maxAiCredits : Number.POSITIVE_INFINITY;
  }
}

module.exports = {
  LIMITS,
  parseRunOptions,
  hasRunLimitOverrides,
  checkpointRunLimits,
  restoreRunLimits,
};
