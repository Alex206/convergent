'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WORKER_A_PROMPT,
  WORKER_B_PROMPT,
  REVIEWER_PROMPT,
  WORKSPACE_FINGERPRINT_RULES,
} = require('../src/orchestrator/prompts');

test('agent prompts distinguish Convergent workspace fingerprints from Git object ids', () => {
  assert.match(WORKSPACE_FINGERPRINT_RULES, /NOT a Git commit SHA, ref, tree, tag, or object id/i);
  assert.match(WORKSPACE_FINGERPRINT_RULES, /HEAD plus staged, unstaged, and untracked/i);
  assert.match(WORKSPACE_FINGERPRINT_RULES, /Never run git rev-parse, git show, git log/i);
  assert.match(WORKSPACE_FINGERPRINT_RULES, /dirty worktree.*normal/i);

  for (const prompt of [WORKER_A_PROMPT, WORKER_B_PROMPT, REVIEWER_PROMPT]) {
    assert.match(prompt, /workspace fingerprint/i);
    assert.match(prompt, /NOT a Git commit SHA/i);
  }
});

test('strong reviewer explicitly rejects the false Git-revision blocker', () => {
  assert.match(REVIEWER_PROMPT, /do not treat a dirty worktree as a mismatch/i);
  assert.match(REVIEWER_PROMPT, /do not run Git-object lookups on the Convergent workspace fingerprint/i);
  assert.match(REVIEWER_PROMPT, /BLOCKED means correctness cannot be established for a substantive reason other than merely expecting a Convergent workspace fingerprint to resolve as a Git object/i);
});
