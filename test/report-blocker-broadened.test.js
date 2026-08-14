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

test('detects live blocked-as-expected missing-prerequisite evidence', () => {
  const check = 'External validator blocked as expected because TASKFLOW_RELEASE_TOKEN is not configured.';
  assert.equal(validationBlockerEvidence(check), true);
  assert.equal(reconcileExplicitValidationBlocker(report(check)).report.verdict, 'blocked');
});

test('detects non-zero required external validator exits', () => {
  const check = 'Required external validator exited 2 because its environment prerequisite is unavailable.';
  assert.equal(validationBlockerEvidence(check), true);
  assert.equal(reconcileExplicitValidationBlocker(report(check, 'changed')).report.verdict, 'blocked');
});

test('detects named missing credential prerequisite without requiring exact validator wording', () => {
  const check = 'TASKFLOW_RELEASE_TOKEN is not set, so release-signature verification could not run.';
  assert.match(explicitBlockerEvidence(report(check)), /TASKFLOW_RELEASE_TOKEN/);
});

test('does not reinterpret ordinary expected negative tests as blockers', () => {
  const check = 'Unit test passed: missing token raises RuntimeError as expected.';
  assert.equal(validationBlockerEvidence(check), false);
  assert.equal(reconcileExplicitValidationBlocker(report(check, 'changed')).report.verdict, 'changed');
});
