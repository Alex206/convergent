'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { coordinatorFlowInstructions, workerFlowInstructions, reviewerFlowInstructions } = require('../src/orchestrator/flow');

test('Fast coordinator rejects planning-inspection tasks and non-reusable inspection hints', () => {
  const prompt = coordinatorFlowInstructions('fast');
  assert.match(prompt, /WRONG = task 1 "inspect files\/symbols" as read_only plus task 2 "implement feature"/);
  assert.match(prompt, /RIGHT = one modifying task/);
  assert.match(prompt, /inspectionHints entry MUST be repository-relative/);
  assert.match(prompt, /existing repository surface you actually observed/);
  assert.match(prompt, /proposed\/new file/);
  assert.match(prompt, /Current repository facts:/);
  assert.match(prompt, /custom batch_view tool/);
  assert.match(prompt, /once paths are known, batch_view is the preferred Fast inspection path/);
});

test('Fast worker contract uses batch_view for known reads and coordinated edits', () => {
  const prompt = workerFlowInstructions('fast');
  assert.match(prompt, /use custom batch_view once/);
  assert.match(prompt, /Do not spend one model continuation per builtin:view call/);
  assert.match(prompt, /one coordinated patch/);
  assert.match(prompt, /current-repository facts already present in the task description/);
  assert.match(prompt, /not a checklist requiring every file to be reopened/);
});

test('Fast reviewer contract batches exact changed-file inspection', () => {
  assert.match(reviewerFlowInstructions('fast'), /use custom batch_view once rather than serial builtin:view calls/);
});
