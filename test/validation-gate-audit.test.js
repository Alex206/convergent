'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validationGateAuditRecord,
  validationGateSetAuditRecord,
} = require('../src/orchestrator/validation-gate-audit');

test('gate audit projection keeps lifecycle metadata but omits captured output and error text', () => {
  const secret = 'super-secret-token-12345';
  const record = validationGateAuditRecord({
    gateId: 'unit',
    validatorId: 'gate:unit:sha256:abc',
    policy: 'required',
    workspaceFolder: 'repo',
    cwd: 'src',
    outcome: 'failed',
    blocksAcceptance: true,
    revisionStable: true,
    beforeRevision: 'rev-a',
    afterRevision: 'rev-a',
    executionError: `permission failed because ${secret}`,
    commandResult: {
      commandId: 'cmd-1',
      pid: 42,
      state: 'completed',
      exitCode: 2,
      elapsedMs: 123,
      stdout: `stdout ${secret}`,
      stderr: `stderr ${secret}`,
      stdoutTruncated: false,
      stderrTruncated: true,
      termination: { method: 'posix-process-group', proven: true, reason: secret, groupGone: true },
    },
  });

  assert.equal(record.type, 'validation_gate_result');
  assert.equal(record.command.commandId, 'cmd-1');
  assert.equal(record.command.exitCode, 2);
  assert.equal(record.command.stdoutBytes, Buffer.byteLength(`stdout ${secret}`));
  assert.equal(record.command.stderrBytes, Buffer.byteLength(`stderr ${secret}`));
  assert.equal(record.command.stderrTruncated, true);
  assert.equal(record.command.termination.proven, true);
  assert.equal(record.executionErrorPresent, true);
  assert.equal(JSON.stringify(record).includes(secret), false);
  assert.equal(Object.hasOwn(record.command, 'stdout'), false);
  assert.equal(Object.hasOwn(record.command, 'stderr'), false);
});

test('gate-set audit projection records aggregate outcomes without individual output', () => {
  const record = validationGateSetAuditRecord({
    candidateRevision: 'rev-a',
    currentRevision: 'rev-a',
    accepted: false,
    blocksAcceptance: true,
    completedAllApplicable: true,
    requiredApplicable: 2,
    requiredPassed: 1,
    revisionError: null,
    evidences: [
      { outcome: 'passed' },
      { outcome: 'failed' },
      { outcome: 'skipped' },
    ],
  });

  assert.equal(record.type, 'validation_gate_set_result');
  assert.equal(record.gateCount, 3);
  assert.deepEqual(record.outcomeCounts, { passed: 1, failed: 1, skipped: 1 });
  assert.equal(record.requiredApplicable, 2);
  assert.equal(record.requiredPassed, 1);
  assert.equal(record.accepted, false);
});
