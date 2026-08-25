'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REVIEWER_ONLY_ARMS,
  SPECIALIZED_PARTITIONS,
  EQUALIZED_REVIEW_METHOD,
  validatePartitions,
  broadReviewPrompt,
  specializedReviewPrompt,
  reviewArmConfig,
} = require('../src/headless/equalized-review-protocols');
const { REVIEW_PROTOCOL_IDS } = require('../src/headless/review-protocols');

test('reviewer-only arms expose Terra, Luna panel-size, and specialized comparisons', () => {
  assert.deepEqual(Object.keys(REVIEWER_ONLY_ARMS), [
    'terra-broad',
    'luna-broad-1',
    'luna-broad-2',
    'luna-broad-3',
    'luna-specialized-3',
  ]);
  assert.equal(reviewArmConfig('terra-broad').reviewerCount, 1);
  assert.equal(reviewArmConfig('luna-broad-1').reviewerCount, 1);
  assert.equal(reviewArmConfig('luna-broad-2').reviewerCount, 2);
  assert.equal(reviewArmConfig('luna-broad-3').reviewerCount, 3);
  assert.equal(reviewArmConfig('luna-specialized-3').specialization, true);
  assert.ok(['luna-broad-1', 'luna-broad-2', 'luna-broad-3'].every((arm) => reviewArmConfig(arm).specialization === false));
});

test('specialized partitions cover the same full aspect catalog exactly once', () => {
  assert.equal(validatePartitions(), true);
  const flattened = SPECIALIZED_PARTITIONS.flatMap((entry) => entry.protocols).sort();
  assert.deepEqual(flattened, [...REVIEW_PROTOCOL_IDS].sort());
});

test('broad and specialized reviewers share the exact complete review-method foundation', () => {
  const broad = broadReviewPrompt();
  assert.ok(broad.startsWith(EQUALIZED_REVIEW_METHOD));
  for (const partition of SPECIALIZED_PARTITIONS) {
    const specialized = specializedReviewPrompt(partition);
    assert.ok(specialized.startsWith(EQUALIZED_REVIEW_METHOD));
    for (const protocolId of REVIEW_PROTOCOL_IDS) {
      assert.match(specialized, new RegExp(protocolId.replace('-', '[-]')));
    }
  }
});

test('equalized review method requires counterexamples and intermediate-state reasoning before CLEAN', () => {
  assert.match(EQUALIZED_REVIEW_METHOD, /falsifying witness/i);
  assert.match(EQUALIZED_REVIEW_METHOD, /intermediate steps/i);
  assert.match(EQUALIZED_REVIEW_METHOD, /previously valid input/i);
  assert.match(EQUALIZED_REVIEW_METHOD, /exception precedence/i);
  assert.match(EQUALIZED_REVIEW_METHOD, /tests actually exercise/i);
});
