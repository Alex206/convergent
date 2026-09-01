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

module.exports = {
  LIMITS,
  parseRunOptions,
  hasRunLimitOverrides,
};
