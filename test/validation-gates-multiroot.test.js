'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runValidationGate } = require('../src/orchestrator/validation-gates');

const approvePermission = async () => ({ kind: 'approve-once' });

function completed(overrides = {}) {
  return {
    commandId: 'cmd-test',
    pid: 123,
    state: 'completed',
    exitCode: 0,
    signal: null,
    error: null,
    cwd: '/repo',
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    termination: null,
    ...overrides,
  };
}

function samePath(left, right) {
  const a = path.resolve(String(left));
  const b = path.resolve(String(right));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

test('secondary-root gate sends the selected absolute cwd to permission policy and managed runtime', async () => {
  const primary = path.resolve(os.tmpdir(), 'validation-primary');
  const secondary = path.resolve(os.tmpdir(), 'validation-secondary');
  const folders = [{ name: 'primary', path: primary }, { name: 'secondary', path: secondary }];
  const permissions = [];
  const executions = [];
  let revisionReads = 0;

  const evidence = await runValidationGate({
    id: 'secondary-check',
    command: 'npm test',
    workspaceFolder: 'secondary',
    cwd: 'packages/core',
  }, {
    workspace: primary,
    workspaceFolders: folders,
    permissionHandler: async (request) => { permissions.push(request); return { kind: 'approve-once' }; },
    runtime: { execute: async (owner, options) => { executions.push({ owner, options }); return completed({ cwd: options.cwd }); } },
    revision: async () => { revisionReads += 1; return 'stable-revision'; },
  });

  const expected = path.join(secondary, 'packages', 'core');
  assert.equal(revisionReads, 3);
  assert.equal(permissions.length, 1);
  assert.equal(samePath(permissions[0].cwd, expected), true);
  assert.equal(executions.length, 1);
  assert.equal(samePath(executions[0].options.cwd, expected), true);
  assert.equal(evidence.workspaceFolder, 'secondary');
  assert.equal(evidence.cwd, 'packages/core');
  assert.equal(evidence.outcome, 'passed');
});

test('unknown workspace folder fails before command execution', async () => {
  let executions = 0;
  const evidence = await runValidationGate({
    id: 'missing-root',
    command: 'npm test',
    workspaceFolder: 'does-not-exist',
  }, {
    workspace: '/repo-a',
    workspaceFolders: [{ name: 'repo-a', path: '/repo-a' }, { name: 'repo-b', path: '/repo-b' }],
    permissionHandler: approvePermission,
    runtime: { execute: async () => { executions += 1; return completed(); } },
    revision: async () => 'stable-revision',
  });

  assert.equal(executions, 0);
  assert.equal(evidence.outcome, 'failed');
  assert.equal(evidence.blocksAcceptance, true);
  assert.match(evidence.executionError, /workspaceFolder is not one of the opened workspace folders/);
});

test('selected root cannot cross into a nested opened root through cwd', async () => {
  const parent = path.resolve(os.tmpdir(), 'validation-parent');
  const child = path.join(parent, 'child');
  let executions = 0;
  const evidence = await runValidationGate({
    id: 'nested-crossing',
    command: 'npm test',
    workspaceFolder: 'parent',
    cwd: 'child/package',
  }, {
    workspace: parent,
    workspaceFolders: [{ name: 'parent', path: parent }, { name: 'child', path: child }],
    permissionHandler: approvePermission,
    runtime: { execute: async () => { executions += 1; return completed(); } },
    revision: async () => 'stable-revision',
  });

  assert.equal(executions, 0);
  assert.equal(evidence.outcome, 'failed');
  assert.match(evidence.executionError, /cwd must stay inside workspace folder parent/);
});

test('real managed backend executes a non-mutating gate in a secondary Git root', async (t) => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'convergent-validation-multiroot-'));
  const primary = path.join(container, 'primary');
  const secondary = path.join(container, 'secondary');
  fs.mkdirSync(primary);
  fs.mkdirSync(secondary);
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', primary]);
  execFileSync('git', ['init', '--quiet', secondary]);

  const evidence = await runValidationGate({
    id: 'real-secondary',
    command: 'node -e "console.log(process.cwd())"',
    workspaceFolder: 'secondary',
    timeoutMs: 10_000,
  }, {
    workspace: primary,
    workspaceFolders: [{ name: 'primary', path: primary }, { name: 'secondary', path: secondary }],
    permissionHandler: approvePermission,
  });

  assert.equal(evidence.outcome, 'passed');
  assert.equal(evidence.revisionStable, true);
  assert.equal(evidence.commandResult.exitCode, 0);
  assert.equal(samePath(evidence.commandResult.stdout.trim(), secondary), true);
});
