'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runValidationGate,
  runValidationGates,
} = require('../src/orchestrator/validation-gates');

const approvePermission = async () => ({ kind: 'approve-once' });

function completed(exitCode = 0, overrides = {}) {
  return {
    commandId: `cmd-${Math.random()}`,
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

test('candidate mismatch before permission prevents gate execution', async () => {
  let permissions = 0;
  let executions = 0;
  const evidence = await runValidationGate({ id: 'unit', command: 'npm test' }, {
    workspace: '/repo',
    expectedRevision: 'candidate-a',
    revision: async () => 'candidate-b',
    permissionHandler: async () => { permissions += 1; return { kind: 'approve-once' }; },
    runtime: { execute: async () => { executions += 1; return completed(); } },
  });

  assert.equal(permissions, 0);
  assert.equal(executions, 0);
  assert.equal(evidence.outcome, 'candidate_changed');
  assert.equal(evidence.candidateRevisionMatched, false);
  assert.equal(evidence.blocksAcceptance, true);
});

test('workspace change while permission is pending prevents command start', async () => {
  let executions = 0;
  const evidence = await runValidationGate({ id: 'unit', command: 'npm test' }, {
    workspace: '/repo',
    revision: revisionSequence('candidate-a', 'candidate-b'),
    permissionHandler: approvePermission,
    runtime: { execute: async () => { executions += 1; return completed(); } },
  });

  assert.equal(executions, 0);
  assert.equal(evidence.outcome, 'invalidated');
  assert.equal(evidence.revisionStable, false);
  assert.match(evidence.executionError, /changed after gate permission and before command start/);
});

test('gate set serially collects non-mutating failures instead of stopping at the first failed check', async () => {
  const executions = [];
  const runtime = {
    execute: async (owner) => {
      executions.push(owner);
      if (owner.endsWith(':required-fail')) return completed(2);
      return completed(0);
    },
  };
  const summary = await runValidationGates([
    { id: 'required-fail', command: 'check-one' },
    { id: 'advisory-pass', command: 'check-two', policy: 'advisory' },
    { id: 'required-pass', command: 'check-three' },
  ], {
    workspace: '/repo',
    revision: async () => 'candidate-a',
    permissionHandler: approvePermission,
    runtime,
  });

  assert.deepEqual(executions, [
    'validation-gate:required-fail',
    'validation-gate:advisory-pass',
    'validation-gate:required-pass',
  ]);
  assert.equal(summary.completedAllApplicable, true);
  assert.equal(summary.requiredApplicable, 2);
  assert.equal(summary.requiredPassed, 1);
  assert.equal(summary.accepted, false);
  assert.equal(summary.blocksAcceptance, true);
  assert.deepEqual(summary.evidences.map((evidence) => evidence.outcome), ['failed', 'passed', 'passed']);
});

test('gate set stops executing after one gate mutates the candidate revision', async () => {
  const executions = [];
  let revisionReads = 0;
  const revision = async () => {
    revisionReads += 1;
    // Aggregate candidate read, first-gate before, first-gate pre-exec are stable;
    // first-gate post-command changes. All later reads remain on the changed revision.
    return revisionReads <= 3 ? 'candidate-a' : 'candidate-b';
  };
  const summary = await runValidationGates([
    { id: 'mutator', command: 'mutate' },
    { id: 'must-not-run', command: 'check' },
  ], {
    workspace: '/repo',
    revision,
    permissionHandler: approvePermission,
    runtime: { execute: async (owner) => { executions.push(owner); return completed(0); } },
  });

  assert.deepEqual(executions, ['validation-gate:mutator']);
  assert.equal(summary.accepted, false);
  assert.equal(summary.completedAllApplicable, false);
  assert.equal(summary.currentRevision, 'candidate-b');
  assert.equal(summary.evidences[0].outcome, 'invalidated');
  assert.equal(summary.evidences[1].outcome, 'not_run');
  assert.match(summary.evidences[1].notRunReason, /mutator produced invalidated/);
});

test('all required gates must pass on the same candidate revision for acceptance', async () => {
  const summary = await runValidationGates([
    { id: 'unit', command: 'unit' },
    { id: 'contract', command: 'contract' },
    { id: 'windows-only', command: 'win', platforms: ['win32'] },
  ], {
    workspace: '/repo',
    platform: 'linux',
    revision: async () => 'candidate-a',
    permissionHandler: approvePermission,
    runtime: { execute: async () => completed(0) },
  });

  assert.equal(summary.accepted, true);
  assert.equal(summary.blocksAcceptance, false);
  assert.equal(summary.candidateRevision, 'candidate-a');
  assert.equal(summary.currentRevision, 'candidate-a');
  assert.equal(summary.requiredApplicable, 2);
  assert.equal(summary.requiredPassed, 2);
  assert.deepEqual(summary.evidences.map((evidence) => evidence.outcome), ['passed', 'passed', 'skipped']);
});

test('gate set with no applicable gates does not fingerprint or execute the workspace', async () => {
  let revisions = 0;
  let executions = 0;
  const summary = await runValidationGates([
    { id: 'windows-only', command: 'win', platforms: ['win32'] },
  ], {
    workspace: '/repo',
    platform: 'linux',
    revision: async () => { revisions += 1; return 'candidate-a'; },
    permissionHandler: approvePermission,
    runtime: { execute: async () => { executions += 1; return completed(); } },
  });

  assert.equal(revisions, 0);
  assert.equal(executions, 0);
  assert.equal(summary.accepted, true);
  assert.equal(summary.requiredApplicable, 0);
  assert.equal(summary.evidences[0].outcome, 'skipped');
});
