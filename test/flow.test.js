'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeFlowMode,
  flowPolicy,
  coordinatorFlowInstructions,
  workerFlowInstructions,
  reviewerFlowInstructions,
} = require('../src/orchestrator/flow');
const { COORDINATOR_PROMPT, REVIEWER_PROMPT, WORKER_A_PROMPT, WORKER_B_PROMPT } = require('../src/orchestrator/prompts');

test('fast flow allows one automatic remediation delta review before asking', () => {
  const policy = flowPolicy('fast', { maxWorkerPasses: 8, maxReviewerCycles: 3 });
  assert.equal(policy.mode, 'fast');
  assert.equal(policy.maxWorkerPasses, 3);
  assert.equal(policy.maxReviewerCycles, 2);
  assert.equal(policy.reviewerScope, 'task-diff');
  assert.match(policy.description, /automatic remediation/i);
  assert.match(coordinatorFlowInstructions('fast'), /one bounded repository-inspection batch/i);
  assert.match(coordinatorFlowInstructions('fast'), /editor settings/i);
  assert.match(coordinatorFlowInstructions('fast'), /Minimize task count/i);
  assert.match(coordinatorFlowInstructions('fast'), /ONE modifying task/i);
  assert.match(coordinatorFlowInstructions('fast'), /at most three total plan tasks/i);
  assert.match(coordinatorFlowInstructions('fast'), /never split implementation from the tests/i);
  assert.match(coordinatorFlowInstructions('fast'), /not a separate read_only plan task/i);
  assert.match(workerFlowInstructions('fast'), /focused inspection/i);
  assert.match(workerFlowInstructions('fast'), /apply_patch/i);
  assert.match(workerFlowInstructions('fast'), /peer already passed/i);
  assert.match(workerFlowInstructions('fast'), /repository-established validation framework/i);
  assert.match(workerFlowInstructions('fast'), /runtime session-state directories/i);
  assert.match(reviewerFlowInstructions('fast'), /instead of mechanically rerunning/i);
});

test('coordinator plans at acceptance boundaries rather than file boundaries', () => {
  assert.match(COORDINATOR_PROMPT, /Plan tasks at acceptance boundaries, not file boundaries/i);
  assert.match(COORDINATOR_PROMPT, /must not become a separate read_only task/i);
  assert.match(COORDINATOR_PROMPT, /inspectionHints/i);
});

test('auto preserves configured soft tranches', () => {
  const policy = flowPolicy('auto', { maxWorkerPasses: 6, maxReviewerCycles: 2 });
  assert.equal(policy.maxWorkerPasses, 6);
  assert.equal(policy.maxReviewerCycles, 2);
  assert.equal(policy.reviewerScope, 'affected-surfaces');
  assert.equal(coordinatorFlowInstructions('auto'), '');
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

test('reviewer flow requires criterion evidence and fresh semantic falsification', () => {
  for (const mode of ['fast', 'auto', 'thorough']) {
    const instructions = reviewerFlowInstructions(mode);
    assert.match(instructions, /acceptance matrix/i);
    assert.match(instructions, /implementation evidence from validation\/test evidence/i);
    assert.match(instructions, /passing test is not proof/i);
    assert.match(instructions, /property-oriented check/i);
    assert.match(instructions, /structurally distinct witnesses/i);
    assert.match(instructions, /global semantic invariant/i);
    assert.match(instructions, /fresh witness or property check/i);
    assert.match(instructions, /Do not invent hidden requirements/i);
  }
});

test('agents protect pre-existing dirty or untracked user workspace state', () => {
  assert.match(WORKER_A_PROMPT, /pre-existing user workspace state as protected/i);
  assert.match(WORKER_B_PROMPT, /never revert\/remove unrelated pre-existing dirty or untracked user state/i);
  assert.match(REVIEWER_PROMPT, /not a task defect merely because it appears in git status/i);
});

test('unknown flow values normalize to auto', () => {
  assert.equal(normalizeFlowMode('speedy'), 'auto');
});
