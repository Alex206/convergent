'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  explicitBlockerEvidence,
  operatorPrerequisiteEvidence,
  reconcileExplicitValidationBlocker,
  reconcileSupersededValidationBlocker,
} = require('../src/orchestrator/report-blocker');

test('non-BLOCKED structured worker verdict is not rewritten from blocker prose', () => {
  const original = {
    verdict: 'changed',
    summary: 'Implementation is complete. The unmodified external validator is explicitly blocked because TASKFLOW_RELEASE_TOKEN is unavailable.',
    findings: [],
    checks: ['python tools/validate_release_signature.py (exit 2: TASKFLOW_RELEASE_TOKEN is not configured)'],
  };
  const reconciled = reconcileExplicitValidationBlocker(original);
  assert.equal(reconciled.report.verdict, 'changed');
  assert.equal(reconciled.correction, null);
  assert.match(explicitBlockerEvidence(original), /explicitly blocked/);
});

test('review FINDINGS/clean semantics are not redirected into blocker recovery by check wording', () => {
  for (const report of [
    {
      verdict: 'changed',
      summary: 'The unchanged release validator reported its explicit missing-token blocker.',
      findings: [],
      checks: ['python tools/validate_release_signature.py (exit 2: TASKFLOW_RELEASE_TOKEN is not configured)'],
    },
    {
      verdict: 'clean',
      summary: 'Code review found no implementation defect.',
      findings: [],
      checks: ['external validation BLOCKED: signing token not configured'],
    },
  ]) {
    assert.equal(reconcileExplicitValidationBlocker(report).report.verdict, report.verdict);
  }
});

test('structured BLOCKED remains BLOCKED even when prior validation prose looks successful', () => {
  const report = {
    verdict: 'blocked',
    summary: 'Required validation cannot currently run.',
    findings: [],
    checks: [],
  };
  const result = reconcileSupersededValidationBlocker(report, [
    { agent: 'Worker A', check: 'required external validation passed' },
  ], { changed: true, role: 'Worker B' });
  assert.equal(result.report.verdict, 'blocked');
  assert.equal(result.correction, null);
});

test('operator prerequisite prose is not a deterministic recovery override', () => {
  assert.equal(operatorPrerequisiteEvidence({
    summary: 'The external validator is blocked because TASKFLOW_RELEASE_TOKEN is unavailable.',
    checks: [],
  }), null);
  assert.equal(operatorPrerequisiteEvidence({
    summary: 'Implementation is otherwise complete.',
    checks: ['required external validation: signing credential is not configured'],
  }), null);
});

test('negative tests and resolved blocker wording remain diagnostic-only', () => {
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
