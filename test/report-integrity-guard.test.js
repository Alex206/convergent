'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasCompletionEvidence,
  hasSuccessfulCheck,
  hasUnresolvedBlockerEvidence,
  reconcileUnsupportedBlockedReport,
} = require('../src/headless/report-integrity-guard');

function blocked(overrides = {}) {
  return {
    verdict: 'blocked',
    summary: 'Implementation is complete. No unresolved issues.',
    findings: [],
    checks: ['python -m unittest: 15 tests passed'],
    ...overrides,
  };
}

test('recognizes explicit completion and successful validation evidence', () => {
  const report = blocked();
  assert.equal(hasCompletionEvidence(report), true);
  assert.equal(hasSuccessfulCheck(report), true);
  assert.equal(hasUnresolvedBlockerEvidence(report), false);
});

test('reconciles self-contradictory BLOCKED to CHANGED when the pass changed the workspace', () => {
  const result = reconcileUnsupportedBlockedReport(blocked(), { changed: true, role: 'Worker A' });
  assert.equal(result.report.verdict, 'changed');
  assert.match(result.correction, /BLOCKED -> CHANGED/);
  assert.match(result.report.checks.at(-1), /report-integrity check/);
});

test('reconciles self-contradictory BLOCKED to CLEAN when the preserved revision is already correct', () => {
  const result = reconcileUnsupportedBlockedReport(blocked({
    summary: 'Current implementation satisfies all requirements. No actionable issues.',
    checks: ['Focused tests passed', 'git diff --check passed'],
  }), { changed: false, role: 'Worker A' });
  assert.equal(result.report.verdict, 'clean');
});

test('preserves genuine missing credential prerequisite BLOCKED', () => {
  const report = blocked({
    summary: 'Implementation is complete, but external validation is unavailable because TASKFLOW_RELEASE_TOKEN is not configured.',
    checks: ['Unit tests passed', 'External validator exit 2: missing TASKFLOW_RELEASE_TOKEN'],
  });
  const result = reconcileUnsupportedBlockedReport(report, { changed: true });
  assert.equal(hasUnresolvedBlockerEvidence(report), true);
  assert.equal(result.report.verdict, 'blocked');
  assert.equal(result.correction, null);
});

test('preserves BLOCKED when any reported validation failed', () => {
  const report = blocked({ checks: ['Unit tests passed', 'Integration validation failed'] });
  const result = reconcileUnsupportedBlockedReport(report, { changed: true });
  assert.equal(result.report.verdict, 'blocked');
});

test('preserves BLOCKED when findings are present', () => {
  const report = blocked({ findings: ['Need to fix the parser edge case'] });
  const result = reconcileUnsupportedBlockedReport(report, { changed: true });
  assert.equal(result.report.verdict, 'blocked');
});

test('preserves ambiguous BLOCKED without explicit completion evidence', () => {
  const report = blocked({ summary: 'Work progressed.', checks: ['Unit tests passed'] });
  const result = reconcileUnsupportedBlockedReport(report, { changed: true });
  assert.equal(result.report.verdict, 'blocked');
});

test('credential-integrity denial evidence can never be unblocked by report consistency', () => {
  const report = blocked({
    summary: 'Implementation is complete. No unresolved issues.',
    checks: [
      'Unit tests passed',
      'Convergent denied synthetic credential assignment; required validation remains blocked pending operator context.',
    ],
  });
  const result = reconcileUnsupportedBlockedReport(report, { changed: true });
  assert.equal(result.report.verdict, 'blocked');
});
