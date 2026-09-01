'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseRunOptions,
  hasRunLimitOverrides,
  checkpointRunLimits,
  restoreRunLimits,
} = require('../src/orchestrator/run-options');

test('per-request AI-credit limit is stripped from the task request', () => {
  const parsed = parseRunOptions('--credits 75.5 Implement the parser fix');
  assert.equal(parsed.request, 'Implement the parser fix');
  assert.deepEqual(parsed.limits, { maxAiCredits: 75.5 });
  assert.equal(hasRunLimitOverrides(parsed.limits), true);
});

test('per-request limits accept equals syntax and any leading option order', () => {
  const parsed = parseRunOptions('--review-cycles=4 --worker-passes 10 --ai-credits=120 Review and fix this');
  assert.equal(parsed.request, 'Review and fix this');
  assert.deepEqual(parsed.limits, {
    maxReviewerCycles: 4,
    maxWorkerPasses: 10,
    maxAiCredits: 120,
  });
});

test('only leading recognized options are interpreted as Convergent run controls', () => {
  const parsed = parseRunOptions('Explain --credits 50 in this documentation');
  assert.equal(parsed.request, 'Explain --credits 50 in this documentation');
  assert.deepEqual(parsed.limits, {});
  assert.equal(hasRunLimitOverrides(parsed.limits), false);
});

test('invalid per-request limits fail deterministically', () => {
  assert.throws(() => parseRunOptions('--review-cycles 0 Fix it'), /1 to 20/);
  assert.throws(() => parseRunOptions('--worker-passes 3.5 Fix it'), /integer/);
  assert.throws(() => parseRunOptions('--credits nope Fix it'), /0 to 100000/);
});

test('checkpoint captures the current effective review and AI-credit ceilings', () => {
  const saved = checkpointRunLimits({
    maxWorkerPasses: 9,
    maxReviewerCycles: 4,
    maxAiCredits: 100,
    aiCreditIncrement: 100,
    aiCreditCeiling: 225,
  });

  assert.deepEqual(saved, {
    maxWorkerPasses: 9,
    maxReviewerCycles: 4,
    maxAiCredits: 100,
    aiCreditIncrement: 100,
    aiCreditCeiling: 225,
    aiCreditsUnlimited: false,
  });
});

test('resume restores exact per-request limits including an increased credit ceiling', () => {
  const engine = {
    maxWorkerPasses: 8,
    maxReviewerCycles: 3,
    maxAiCredits: 0,
    aiCreditIncrement: 0,
    aiCreditCeiling: Number.POSITIVE_INFINITY,
  };

  restoreRunLimits(engine, {
    maxWorkerPasses: 10,
    maxReviewerCycles: 5,
    maxAiCredits: 100,
    aiCreditIncrement: 100,
    aiCreditCeiling: 250,
    aiCreditsUnlimited: false,
  });

  assert.equal(engine.maxWorkerPasses, 10);
  assert.equal(engine.maxReviewerCycles, 5);
  assert.equal(engine.maxAiCredits, 100);
  assert.equal(engine.aiCreditIncrement, 100);
  assert.equal(engine.aiCreditCeiling, 250);
});

test('resume preserves an unlimited credit decision', () => {
  const engine = {
    maxWorkerPasses: 8,
    maxReviewerCycles: 3,
    maxAiCredits: 100,
    aiCreditIncrement: 100,
    aiCreditCeiling: 100,
  };

  restoreRunLimits(engine, {
    maxWorkerPasses: 8,
    maxReviewerCycles: 3,
    maxAiCredits: 100,
    aiCreditIncrement: 100,
    aiCreditCeiling: null,
    aiCreditsUnlimited: true,
  });

  assert.equal(engine.aiCreditCeiling, Number.POSITIVE_INFINITY);
});
