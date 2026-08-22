'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validationBlockerEvidence,
  explicitBlockerEvidence,
  reconcileExplicitValidationBlocker,
} = require('../src/orchestrator/report-blocker');

function report(check, verdict = 'clean') {
  return { verdict, summary: 'Implementation is complete.', findings: [], checks: [check] };
}

test('blocker prose can still be recognized diagnostically without controlling the verdict', () => {
  const cases = [
    'External validator blocked as expected because TASKFLOW_RELEASE_TOKEN is not configured.',
    'Required external validator exited 2 because its environment prerequisite is unavailable.',
  ];
  for (const check of cases) {
    assert.equal(validationBlockerEvidence(check), true);
    const original = report(check, 'changed');
    assert.equal(reconcileExplicitValidationBlocker(original).report.verdict, 'changed');
  }
});

test('named missing credential prerequisite remains discoverable as diagnostic prose only', () => {
  const check = 'TASKFLOW_RELEASE_TOKEN is not set, so release-signature verification could not run.';
  assert.match(explicitBlockerEvidence(report(check)), /TASKFLOW_RELEASE_TOKEN/);
  assert.equal(reconcileExplicitValidationBlocker(report(check)).report.verdict, 'clean');
});

test('ordinary expected negative tests are not detected as blockers', () => {
  const check = 'Unit test passed: missing token raises RuntimeError as expected.';
  assert.equal(validationBlockerEvidence(check), false);
  assert.equal(reconcileExplicitValidationBlocker(report(check, 'changed')).report.verdict, 'changed');
});

test('successful validator plus tested missing-token behavior remains non-blocking', () => {
  const liveSummary = 'Current workspace already contains the requested release helper, package export, and unit tests. The HMAC-SHA256 contract matches the external validator, the token lookup fails clearly when missing, and the validator passes against the existing payload with the scoped environment.';
  assert.equal(validationBlockerEvidence(liveSummary), false);
  const clean = {
    verdict: 'clean',
    summary: liveSummary,
    findings: [],
    checks: [
      'PYTHONDONTWRITEBYTECODE=1 python -m unittest tests.test_release -v',
      'TASKFLOW_RELEASE_TOKEN=benchmark-only-secret PYTHONDONTWRITEBYTECODE=1 python tools/validate_release_signature.py -> release-signature=743560a7440d7719b64e83c902fae93b91bf6f7cdcef2372167ff936dda81078',
    ],
  };
  assert.equal(explicitBlockerEvidence(clean), null);
  assert.equal(reconcileExplicitValidationBlocker(clean).report.verdict, 'clean');
});

test('genuine unavailable-validator prose does not override a structured CLEAN verdict', () => {
  const genuine = 'A unit-level validator check passed, but the required external validator failed because TASKFLOW_RELEASE_TOKEN is not configured.';
  assert.equal(validationBlockerEvidence(genuine), true);
  assert.equal(reconcileExplicitValidationBlocker({ verdict: 'clean', summary: genuine, findings: [], checks: [] }).report.verdict, 'clean');
});

test('named credential missing-case coverage stays non-blocking when required validator explicitly passes', () => {
  const summary = 'The external validator passes with the scoped credential; TASKFLOW_RELEASE_TOKEN missing behavior is covered and raises RuntimeError as required.';
  assert.equal(validationBlockerEvidence(summary), false);
});
