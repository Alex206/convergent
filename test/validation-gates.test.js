'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  normalizeValidationGate,
  validationGateApplies,
  buildValidationGateEvidence,
  validationGateEvidenceIsCurrent,
  runValidationGate,
} = require('../src/orchestrator/validation-gates');

const approvePermission = async () => ({ kind: 'approve' });

function completed(exitCode = 0, overrides = {}) {
  return {
    commandId: 'cmd-test',
    pid: 123,
    state: 'completed',
    exitCode,
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

function revisionSequence(...values) {
  let index = 0;
  return async () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    if (value instanceof Error) throw value;
    return value;
  };
}

test('normalizes gate definitions and derives a stable validator identity', () => {
  const left = normalizeValidationGate({
    id: 'Build.Contract',
    command: 'npm test',
    policy: 'REQUIRED',
    timeoutMs: 12_000,
    cwd: './packages/core',
    platforms: ['win32', 'linux', 'linux'],
  });
  const right = normalizeValidationGate({
    platforms: ['linux', 'win32'],
    cwd: 'packages/core',
    timeoutMs: 12_000,
    policy: 'required',
    command: 'npm test',
    id: 'build.contract',
  });

  assert.deepEqual(left, right);
  assert.equal(left.id, 'build.contract');
  assert.equal(left.cwd, 'packages/core');
  assert.deepEqual(left.platforms, ['linux', 'win32']);
  assert.match(left.validatorId, /^gate:build\.contract:sha256:[0-9a-f]{64}$/);
});

test('rejects malformed or host-escaping gate definitions', () => {
  assert.throws(() => normalizeValidationGate({ id: '', command: 'npm test' }), /Invalid validation gate: id/);
  assert.throws(() => normalizeValidationGate({ id: 'test', command: '' }), /command must be a non-empty string/);
  assert.throws(() => normalizeValidationGate({ id: 'test', command: 'npm test', policy: 'optional' }), /policy must be required or advisory/);
  assert.throws(() => normalizeValidationGate({ id: 'test', command: 'npm test', cwd: '../outside' }), /cwd must stay inside/);
  assert.throws(() => normalizeValidationGate({ id: 'test', command: 'npm test', cwd: 'C:\\outside' }), /cwd must be repository-relative/);
  assert.throws(() => normalizeValidationGate({ id: 'test', command: 'npm test', timeoutMs: 20 }), /timeoutMs must be an integer/);
  assert.throws(() => normalizeValidationGate({ id: 'test', command: 'npm test', platforms: ['windows'] }), /unsupported platform/);
});

test('platform applicability is explicit and a non-applicable required gate is skipped', async () => {
  const gate = normalizeValidationGate({ id: 'linux-only', command: 'true', platforms: ['linux'] });
  assert.equal(validationGateApplies(gate, 'linux'), true);
  assert.equal(validationGateApplies(gate, 'win32'), false);

  let executions = 0;
  const evidence = await runValidationGate(gate, {
    workspace: '/repo',
    platform: 'win32',
    revision: async () => { throw new Error('revision should not be read for skipped gate'); },
    runtime: { execute: async () => { executions += 1; } },
  });

  assert.equal(executions, 0);
  assert.equal(evidence.outcome, 'skipped');
  assert.equal(evidence.blocksAcceptance, false);
  assert.equal(evidence.skippedForPlatform, 'win32');
});

test('runs a required gate through the managed runtime and binds success to one exact revision', async () => {
  const calls = [];
  const permissions = [];
  const runtime = {
    execute: async (owner, options) => {
      calls.push({ owner, options });
      return completed(0);
    },
  };
  const evidence = await runValidationGate({
    id: 'unit',
    command: 'npm test',
    cwd: 'packages/core',
    timeoutMs: 9_000,
  }, {
    workspace: '/repo',
    platform: 'linux',
    runtime,
    permissionHandler: async (request) => { permissions.push(request); return { kind: 'approve' }; },
    revision: revisionSequence('rev-a', 'rev-a'),
  });

  assert.equal(permissions.length, 1);
  assert.equal(permissions[0].kind, 'shell');
  assert.equal(permissions[0].fullCommandText, 'npm test');
  assert.equal(permissions[0].toolName, 'validation_gate');
  assert.equal(permissions[0].cwd, path.resolve('/repo/packages/core'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].owner, 'validation-gate:unit');
  assert.equal(calls[0].options.command, 'npm test');
  assert.equal(calls[0].options.cwd, 'packages/core');
  assert.equal(calls[0].options.timeoutMs, 9_000);
  assert.equal(evidence.outcome, 'passed');
  assert.equal(evidence.revisionStable, true);
  assert.equal(evidence.beforeRevision, 'rev-a');
  assert.equal(evidence.afterRevision, 'rev-a');
  assert.equal(evidence.blocksAcceptance, false);
  assert.equal(validationGateEvidenceIsCurrent(evidence, 'rev-a'), true);
  assert.equal(validationGateEvidenceIsCurrent(evidence, 'rev-b'), false);
});

test('missing or denied shell permission prevents gate command execution', async () => {
  for (const permissionHandler of [undefined, async () => ({ kind: 'deny' })]) {
    let executions = 0;
    const evidence = await runValidationGate({ id: 'permission-check', command: 'npm test' }, {
      workspace: '/repo',
      permissionHandler,
      runtime: { execute: async () => { executions += 1; return completed(0); } },
      revision: revisionSequence('rev-a', 'rev-a'),
    });
    assert.equal(executions, 0);
    assert.equal(evidence.outcome, 'failed');
    assert.equal(evidence.blocksAcceptance, true);
    assert.match(evidence.executionError, /permission (?:handler is unavailable|denied)/i);
  }
});

test('non-zero, timeout and execution errors fail a required gate', async () => {
  for (const commandResult of [
    completed(3),
    completed(null, { state: 'timed_out', termination: { proven: true } }),
  ]) {
    const evidence = await runValidationGate({ id: 'required-check', command: 'check' }, {
      workspace: '/repo',
      permissionHandler: approvePermission,
      runtime: { execute: async () => commandResult },
      revision: revisionSequence('rev-a', 'rev-a'),
    });
    assert.equal(evidence.outcome, 'failed');
    assert.equal(evidence.blocksAcceptance, true);
    assert.equal(validationGateEvidenceIsCurrent(evidence, 'rev-a'), false);
  }

  const thrown = await runValidationGate({ id: 'required-check', command: 'check' }, {
    workspace: '/repo',
    permissionHandler: approvePermission,
    runtime: { execute: async () => { throw new Error('runtime unavailable'); } },
    revision: revisionSequence('rev-a', 'rev-a'),
  });
  assert.equal(thrown.outcome, 'failed');
  assert.equal(thrown.blocksAcceptance, true);
  assert.match(thrown.executionError, /runtime unavailable/);
});

test('any gate that mutates the reviewed revision invalidates acceptance even if advisory and exit zero', async () => {
  const evidence = await runValidationGate({ id: 'lint', command: 'lint --fix', policy: 'advisory' }, {
    workspace: '/repo',
    permissionHandler: approvePermission,
    runtime: { execute: async () => completed(0) },
    revision: revisionSequence('rev-before', 'rev-after'),
  });

  assert.equal(evidence.outcome, 'invalidated');
  assert.equal(evidence.revisionStable, false);
  assert.equal(evidence.blocksAcceptance, true);
  assert.equal(validationGateEvidenceIsCurrent(evidence, 'rev-after'), false);
});

test('advisory failure is recorded without blocking when the revision remains unchanged', () => {
  const evidence = buildValidationGateEvidence({
    gate: { id: 'lint', command: 'lint', policy: 'advisory' },
    beforeRevision: 'rev-a',
    afterRevision: 'rev-a',
    commandResult: completed(2),
  });
  assert.equal(evidence.outcome, 'failed');
  assert.equal(evidence.blocksAcceptance, false);
});

test('missing revision evidence fails closed and prevents permission check or command execution', async () => {
  let permissions = 0;
  let executions = 0;
  const evidence = await runValidationGate({ id: 'unit', command: 'npm test' }, {
    workspace: '/repo',
    permissionHandler: async () => { permissions += 1; return { kind: 'approve' }; },
    revision: revisionSequence(new Error('not a git worktree')),
    runtime: { execute: async () => { executions += 1; return completed(0); } },
  });
  assert.equal(permissions, 0);
  assert.equal(executions, 0);
  assert.equal(evidence.outcome, 'revision_unavailable');
  assert.equal(evidence.blocksAcceptance, true);
  assert.match(evidence.executionError, /not a git worktree/);
});

test('real managed backend passes a non-mutating gate and invalidates a zero-exit mutating gate', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convergent-validation-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);

  const clean = await runValidationGate({
    id: 'real-pass',
    command: 'node -e "process.exit(0)"',
    timeoutMs: 10_000,
  }, { workspace: root, permissionHandler: approvePermission });
  assert.equal(clean.outcome, 'passed');
  assert.equal(clean.commandResult.state, 'completed');
  assert.equal(clean.commandResult.exitCode, 0);
  assert.equal(clean.revisionStable, true);

  const mutation = await runValidationGate({
    id: 'real-mutation',
    command: 'node -e "require(\'fs\').writeFileSync(\'gate-output.txt\', \'changed\')"',
    timeoutMs: 10_000,
  }, { workspace: root, permissionHandler: approvePermission });
  assert.equal(mutation.commandResult.state, 'completed');
  assert.equal(mutation.commandResult.exitCode, 0);
  assert.equal(mutation.outcome, 'invalidated');
  assert.equal(mutation.blocksAcceptance, true);
  assert.equal(mutation.revisionStable, false);
  assert.equal(fs.readFileSync(path.join(root, 'gate-output.txt'), 'utf8'), 'changed');
});
