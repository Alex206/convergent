'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeFlowMode,
  flowPolicy,
  workerFlowInstructions,
  reviewerFlowInstructions,
} = require('../src/orchestrator/flow');
const { REVIEWER_PROMPT } = require('../src/orchestrator/prompts');

test('fast flow asks sooner without removing the strong review gate', () => {
  const policy = flowPolicy('fast', { maxWorkerPasses: 8, maxReviewerCycles: 3 });
  assert.equal(policy.mode, 'fast');
  assert.equal(policy.maxWorkerPasses, 3);
  assert.equal(policy.maxReviewerCycles, 1);
  assert.equal(policy.reviewerScope, 'task-diff');
  assert.match(policy.description, /stronger adaptive implementation/i);
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

test('base reviewer collects findings before reporting and later uses remediation delta', () => {
  assert.match(REVIEWER_PROMPT, /continue the bounded review rather than stopping immediately/i);
  assert.match(REVIEWER_PROMPT, /report all independently discoverable actionable findings/i);
  assert.match(REVIEWER_PROMPT, /remediation delta/i);
  assert.match(reviewerFlowInstructions('auto'), /task diff/i);
});

test('unknown flow values normalize to auto', () => {
  assert.equal(normalizeFlowMode('speedy'), 'auto');
});
