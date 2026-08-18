'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileDeterministicIntegrity } = require('../src/orchestrator/engine');

test('credential-integrity BLOCKED is preserved as a deterministic override', () => {
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

test('required-validation prose does not rewrite CHANGED into BLOCKED', () => {
  const result = reconcileDeterministicIntegrity({
    verdict: 'changed',
    summary: 'Implementation is complete. No unresolved issues.',
    findings: [],
    checks: [
      'Focused tests passed',
      'Required external validator exited 2 because TASKFLOW_RELEASE_TOKEN is not configured.',
    ],
  }, { changed: true, role: 'Worker A' });

  assert.equal(result.report.verdict, 'changed');
  assert.equal(result.correction, null);
});

test('completion prose does not rewrite structured BLOCKED into CLEAN', () => {
  const result = reconcileDeterministicIntegrity({
    verdict: 'blocked',
    summary: 'Implementation is complete. No unresolved issues.',
    findings: [],
    checks: ['Focused tests passed'],
  }, { changed: false, role: 'Strong reviewer' });

  assert.equal(result.report.verdict, 'blocked');
  assert.equal(result.correction, null);
});
