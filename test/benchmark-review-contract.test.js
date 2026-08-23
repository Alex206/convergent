'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewerFlowInstructions } = require('../src/orchestrator/flow');

const ENV_KEY = 'CONVERGENT_BENCHMARK_REVIEW_CONTRACT';

function withReviewContract(value, fn) {
  const previous = process.env[ENV_KEY];
  if (value == null) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    fn();
  } finally {
    if (previous == null) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  }
}

test('default reviewer instructions do not include benchmark trust-boundary contract', () => {
  withReviewContract('acceptance-matrix-v1', () => {
    const instructions = reviewerFlowInstructions('fast');
    assert.doesNotMatch(instructions, /BENCHMARK TRUST-BOUNDARY COMPOSITION REVIEW/);
  });
});

test('trust-boundary benchmark selector adds hostile and benign composition witnesses', () => {
  withReviewContract('trust-boundary-composition-v1', () => {
    const instructions = reviewerFlowInstructions('fast');
    assert.match(instructions, /BENCHMARK TRUST-BOUNDARY COMPOSITION REVIEW/);
    assert.match(instructions, /intermediate state crosses, escapes, or rebinds the trust boundary/);
    assert.match(instructions, /bounded benign witness/);
    assert.match(instructions, /final-state-only near miss and an over-restrictive remediation/);
  });
});
