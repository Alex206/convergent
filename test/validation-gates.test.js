'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeValidationGate,
  validationGateApplies,
  buildValidationGateEvidence,
  validationGateEvidenceIsCurrent,
  runValidationGate,
} = require('../src/orchestrator/validation-gates');

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
    revision: revisionSequence('rev-a', 'rev-a'),
  });

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

test('non-zero, timeout and execution errors fail a required gate', async () => {
  for (const commandResult of [
    completed(3),
    completed(null, { state: 'timed_out', termination: { proven: true } }),
  ]) {
    const evidence = await runValidationGate({ id: 'required-check', command: 'check' }, {
      workspace: '/repo',
      runtime: { execute: async () => commandResult },
      revision: revisionSequence('rev-a', 'rev-a'),
    });
    assert.equal(evidence.outcome, 'failed');
    assert.equal(evidence.blocksAcceptance, true);
    assert.equal(validationGateEvidenceIsCurrent(evidence, 'rev-a'), false);
  }

  const thrown = await runValidationGate({ id: 'required-check', command: 'check' }, {
    workspace: '/repo',
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

test('missing revision evidence fails closed and prevents command execution when the initial fingerprint is unavailable', async () => {
  let executions = 0;
  const evidence = await runValidationGate({ id: 'unit', command: 'npm test' }, {
    workspace: '/repo',
    revision: revisionSequence(new Error('not a git worktree')),
    runtime: { execute: async () => { executions += 1; return completed(0); } },
  });
  assert.equal(executions, 0);
  assert.equal(evidence.outcome, 'revision_unavailable');
  assert.equal(evidence.blocksAcceptance, true);
  assert.match(evidence.executionError, /not a git worktree/);
});
