'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeFlowMode,
  flowPolicy,
  workerFlowInstructions,
  reviewerFlowInstructions,
} = require('../src/orchestrator/flow');

test('fast flow asks sooner without removing the strong review gate', () => {
  const policy = flowPolicy('fast', { maxWorkerPasses: 8, maxReviewerCycles: 3 });
  assert.equal(policy.mode, 'fast');
  assert.equal(policy.maxWorkerPasses, 3);
  assert.equal(policy.maxReviewerCycles, 1);
  assert.equal(policy.reviewerScope, 'task-diff');
  assert.match(workerFlowInstructions('fast'), /focused inspection/i);
});

test('auto preserves configured soft tranches', () => {
  const policy = flowPolicy('auto', { maxWorkerPasses: 6, maxReviewerCycles: 2 });
  assert.equal(policy.maxWorkerPasses, 6);
  assert.equal(policy.maxReviewerCycles, 2);
  assert.equal(policy.reviewerScope, 'affected-surfaces');
});

test('thorough never shrinks assurance tranches', () => {
  const policy = flowPolicy('thorough', { maxWorkerPasses: 4, maxReviewerCycles: 1 });
  assert.equal(policy.maxWorkerPasses, 8);
  assert.equal(policy.maxReviewerCycles, 3);
  assert.equal(policy.reviewerScope, 'comprehensive');
});

test('reviewer guidance collects findings before reporting and later uses remediation delta', () => {
  const prompt = reviewerFlowInstructions('auto');
  assert.match(prompt, /do not stop.*first actionable defect/i);
  assert.match(prompt, /report all independently discoverable actionable findings together/i);
  assert.match(prompt, /remediation delta/i);
});

test('unknown flow values normalize to auto', () => {
  assert.equal(normalizeFlowMode('speedy'), 'auto');
});
