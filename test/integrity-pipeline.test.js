'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileDeterministicIntegrity } = require('../src/orchestrator/engine');

test('credential-integrity BLOCKED is preserved through later deterministic reconciliation', () => {
  const result = reconcileDeterministicIntegrity({
    verdict: 'clean',
    summary: 'Implementation is complete. No unresolved issues.',
    findings: [],
    checks: ['Focused tests passed'],
  }, {
    changed: true,
    role: 'Worker A',
    credentialViolations: [{ names: ['TASKFLOW_RELEASE_TOKEN'] }],
  });

  assert.equal(result.report.verdict, 'blocked');
  assert.match(result.report.summary, /Operator context is required/);
  assert.match(result.report.checks.join('\n'), /denied .*operator-controlled credential/i);
  assert.doesNotMatch(JSON.stringify(result.report), /made-up-secret/);
});

test('required-validation blocker reconciliation precedes contradictory-BLOCKED cleanup', () => {
  const result = reconcileDeterministicIntegrity({
    verdict: 'changed',
    summary: 'Implementation is complete. No unresolved issues.',
    findings: [],
    checks: [
      'Focused tests passed',
      'Required external validator exited 2 because TASKFLOW_RELEASE_TOKEN is not configured.',
    ],
  }, { changed: true, role: 'Worker A' });

  assert.equal(result.report.verdict, 'blocked');
  assert.match(result.correction, /BLOCKED/);
});

test('unsupported BLOCKED is reconciled only after stronger blocker evidence checks are exhausted', () => {
  const result = reconcileDeterministicIntegrity({
    verdict: 'blocked',
    summary: 'Implementation is complete. No unresolved issues.',
    findings: [],
    checks: ['Focused tests passed'],
  }, { changed: false, role: 'Strong reviewer' });

  assert.equal(result.report.verdict, 'clean');
  assert.match(result.correction, /BLOCKED -> CLEAN/);
});
