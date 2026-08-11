'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { coordinatorFlowInstructions, workerFlowInstructions } = require('../src/orchestrator/flow');

test('Fast coordinator rejects planning-inspection tasks and non-reusable inspection hints', () => {
  const prompt = coordinatorFlowInstructions('fast');
  assert.match(prompt, /WRONG = task 1 "inspect files\/symbols" as read_only plus task 2 "implement feature"/);
  assert.match(prompt, /RIGHT = one modifying task/);
  assert.match(prompt, /inspectionHints entry MUST be repository-relative/);
  assert.match(prompt, /existing repository surface you actually observed/);
  assert.match(prompt, /proposed\/new file/);
  assert.match(prompt, /Current repository facts:/);
  assert.match(prompt, /parallel\/batched tool roundtrip/);
});

test('Fast worker contract batches known reads and coordinated edits', () => {
  const prompt = workerFlowInstructions('fast');
  assert.match(prompt, /SAME assistant turn/);
  assert.match(prompt, /view file A, wait for a new model continuation/);
  assert.match(prompt, /one coordinated patch/);
  assert.match(prompt, /current-repository facts already present in the task description/);
  assert.match(prompt, /not a checklist requiring every file to be reopened/);
});
