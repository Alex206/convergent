'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readonlyHook,
  workerHook,
  readonlyShellMutation,
  shellFileContentMutation,
  safeSessionPart,
  SHELL_BUILTINS,
  COORDINATOR_TOOLS,
  WORKER_TOOLS,
  REVIEWER_TOOLS,
} = require('../src/copilot/session-factory');

test('strong reviewer hook blocks write tools', () => {
  assert.equal(readonlyHook({ toolName: 'edit' }).permissionDecision, 'deny');
  assert.equal(readonlyHook({ toolName: 'write_file' }).permissionDecision, 'deny');
  assert.equal(readonlyHook({ toolName: 'apply_patch' }).permissionDecision, 'deny');
});

test('read-only roles allow diagnostic shell commands without separate permission prompts', () => {
  assert.equal(readonlyHook({ toolName: 'powershell', toolArgs: { command: 'git status --short' } }).permissionDecision, 'allow');
  assert.equal(readonlyHook({ toolName: 'bash', toolArgs: { command: 'git diff -- README.md' } }).permissionDecision, 'allow');
  assert.equal(readonlyHook({ toolName: 'grep', toolArgs: { pattern: 'foo' } }).permissionDecision, 'allow');
});

test('read-only roles deny obvious shell mutations before execution', () => {
  assert.equal(readonlyShellMutation({ toolName: 'powershell', toolArgs: { command: 'Set-Content README.md changed' } }), true);
  assert.equal(readonlyHook({ toolName: 'powershell', toolArgs: { command: 'git reset --hard HEAD~1' } }).permissionDecision, 'deny');
  assert.equal(readonlyHook({ toolName: 'bash', toolArgs: { command: 'rm -rf src' } }).permissionDecision, 'deny');
});

test('worker hook blocks shell file-content editing but allows validation and cleanup', () => {
  assert.equal(shellFileContentMutation({ toolName: 'powershell', toolArgs: { command: 'Set-Content README.md changed' } }), true);
  assert.equal(workerHook({ toolName: 'powershell', toolArgs: { command: 'Set-Content README.md changed' } }).permissionDecision, 'deny');
  assert.equal(workerHook({ toolName: 'bash', toolArgs: { command: 'printf hello > README.md' } }).permissionDecision, 'deny');
  assert.equal(workerHook({ toolName: 'bash', toolArgs: { command: 'apply_patch <<PATCH' } }).permissionDecision, 'deny');
  assert.equal(workerHook({ toolName: 'powershell', toolArgs: { command: 'python -B -m unittest -v' } }).permissionDecision, 'allow');
  assert.equal(shellFileContentMutation({ toolName: 'powershell', toolArgs: { command: 'Remove-Item -Recurse __pycache__' } }), false);
});

test('role tool allowlists expose purpose-built file tools only to workers', () => {
  assert.equal(SHELL_BUILTINS.length, 1);
  assert.ok(COORDINATOR_TOOLS.includes('builtin:view'));
  assert.ok(COORDINATOR_TOOLS.includes('builtin:ask_user'));
  assert.ok(COORDINATOR_TOOLS.includes('custom:report_plan'));
  assert.ok(!COORDINATOR_TOOLS.includes('builtin:edit'));
  assert.ok(!COORDINATOR_TOOLS.includes('builtin:create'));
  assert.ok(!COORDINATOR_TOOLS.includes('builtin:apply_patch'));

  assert.ok(REVIEWER_TOOLS.includes('custom:report_review'));
  assert.ok(!REVIEWER_TOOLS.includes('builtin:edit'));
  assert.ok(!REVIEWER_TOOLS.includes('builtin:apply_patch'));
  assert.ok(!REVIEWER_TOOLS.includes('builtin:ask_user'));

  assert.ok(WORKER_TOOLS.includes('builtin:apply_patch'));
  assert.ok(WORKER_TOOLS.includes('builtin:edit'));
  assert.ok(WORKER_TOOLS.includes('builtin:create'));
  assert.ok(WORKER_TOOLS.includes('custom:report_pass'));
  assert.ok(!WORKER_TOOLS.includes('builtin:ask_user'));
});

test('session ids sanitize coordinator-provided task ids', () => {
  assert.equal(safeSessionPart('Task 1 / Windows runner'), 'Task-1-Windows-runner');
  assert.equal(safeSessionPart('///'), 'task');
});
