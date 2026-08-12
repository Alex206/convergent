'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  explicitBlockerEvidence,
  reconcileExplicitValidationBlocker,
} = require('../src/orchestrator/report-blocker');

test('non-BLOCKED worker report is reconciled when its own summary says required validation is blocked', () => {
  const original = {
    verdict: 'changed',
    summary: 'Implementation is complete. The unmodified external validator is explicitly blocked because TASKFLOW_RELEASE_TOKEN is unavailable.',
    findings: [],
    checks: ['python tools/validate_release_signature.py (exit 2: TASKFLOW_RELEASE_TOKEN is not configured)'],
  };
  const reconciled = reconcileExplicitValidationBlocker(original);
  assert.equal(reconciled.report.verdict, 'blocked');
  assert.match(reconciled.correction, /CHANGED -> BLOCKED/);
  assert.match(explicitBlockerEvidence(original), /explicitly blocked/);
});

test('explicit BLOCKED check evidence cannot be reported CLEAN', () => {
  const report = {
    verdict: 'clean',
    summary: 'Code review found no implementation defect.',
    findings: [],
    checks: ['external validation BLOCKED: signing token not configured'],
  };
  assert.equal(reconcileExplicitValidationBlocker(report).report.verdict, 'blocked');
});

test('negative tests and resolved blocker wording do not create false BLOCKED verdicts', () => {
  for (const report of [
    {
      verdict: 'changed',
      summary: 'Added tests for the missing-token RuntimeError; no blockers remain.',
      findings: [],
      checks: ['unit test verifies missing token raises RuntimeError as expected'],
    },
    {
      verdict: 'clean',
      summary: 'The previously blocked validation is not blocked after operator guidance.',
      findings: [],
      checks: ['required external validation succeeded'],
    },
  ]) {
    const reconciled = reconcileExplicitValidationBlocker(report);
    assert.equal(reconciled.report.verdict, report.verdict);
    assert.equal(reconciled.correction, null);
  }
});
