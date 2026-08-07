'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readonlyHook, safeSessionPart } = require('../src/copilot/session-factory');

test('strong reviewer hook blocks write tools', () => {
  assert.equal(readonlyHook({ toolName: 'edit' }).permissionDecision, 'deny');
  assert.equal(readonlyHook({ toolName: 'write_file' }).permissionDecision, 'deny');
  assert.equal(readonlyHook({ toolName: 'apply_patch' }).permissionDecision, 'deny');
});

test('strong reviewer hook does not create separate shell permission prompts', () => {
  assert.equal(readonlyHook({ toolName: 'bash' }).permissionDecision, 'allow');
  assert.equal(readonlyHook({ toolName: 'powershell' }).permissionDecision, 'allow');
  assert.equal(readonlyHook({ toolName: 'grep' }).permissionDecision, 'allow');
});

test('session ids sanitize coordinator-provided task ids', () => {
  assert.equal(safeSessionPart('Task 1 / Windows runner'), 'Task-1-Windows-runner');
  assert.equal(safeSessionPart('///'), 'task');
});
