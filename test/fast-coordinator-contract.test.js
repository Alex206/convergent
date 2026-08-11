'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { coordinatorFlowInstructions } = require('../src/orchestrator/flow');

test('Fast coordinator rejects planning-inspection tasks and absolute inspection hints in its contract', () => {
  const prompt = coordinatorFlowInstructions('fast');
  assert.match(prompt, /WRONG = task 1 "inspect files\/symbols" as read_only plus task 2 "implement feature"/);
  assert.match(prompt, /RIGHT = one modifying task/);
  assert.match(prompt, /inspectionHints entry MUST be repository-relative/);
  assert.match(prompt, /Never put an absolute workspace path/);
  assert.match(prompt, /parallel\/batched tool roundtrip/);
});
