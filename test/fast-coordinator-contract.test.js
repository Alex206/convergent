'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { coordinatorFlowInstructions, workerFlowInstructions, reviewerFlowInstructions } = require('../src/orchestrator/flow');

test('Fast coordinator requires one batch discovery and acceptance-boundary planning', () => {
  const prompt = coordinatorFlowInstructions('fast');
  assert.match(prompt, /Use custom batch_view as the PRIMARY Fast discovery tool/);
  assert.match(prompt, /queries/);
  assert.match(prompt, /globs/);
  assert.match(prompt, /readMatches=true/);
  assert.match(prompt, /WRONG = grep symbol A, grep symbol B, glob files, view file A, view file B/);
  assert.match(prompt, /WRONG = task 1 "inspect files\/symbols" as read_only plus task 2 "implement feature"/);
  assert.match(prompt, /RIGHT = one modifying task/);
  assert.match(prompt, /inspectionHints entry MUST be repository-relative/);
  assert.match(prompt, /existing repository surface you actually observed/);
  assert.match(prompt, /proposed\/new file/);
  assert.match(prompt, /Current repository facts:/);
});

test('Fast worker contract uses batch_view for discovery/reads and coordinated edits', () => {
  const prompt = workerFlowInstructions('fast');
  assert.match(prompt, /use custom batch_view once/);
  assert.match(prompt, /queries\/globs/);
  assert.match(prompt, /readMatches=true/);
  assert.match(prompt, /Do not spend one model continuation per builtin:view\/grep\/glob call/);
  assert.match(prompt, /one coordinated patch/);
  assert.match(prompt, /current-repository facts already present in the task description/);
  assert.match(prompt, /not a checklist requiring every file to be reopened/);
});

test('Fast reviewer contract batches exact or uncertain changed-file inspection', () => {
  const prompt = reviewerFlowInstructions('fast');
  assert.match(prompt, /use custom batch_view once rather than serial builtin:view calls/);
  assert.match(prompt, /queries\/globs and readMatches=true/);
});
