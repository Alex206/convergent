'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasCompletionEvidence,
  hasExplicitNoIssueEvidence,
  hasSuccessfulCheck,
  hasUnresolvedBlockerEvidence,
  reconcileUnsupportedBlockedReport,
} = require('../src/orchestrator/report-integrity');

function blocked(overrides = {}) {
  return {
    verdict: 'blocked',
    summary: 'Implementation is complete. No unresolved issues.',
    findings: [],
    checks: ['python -m unittest: 15 tests passed'],
    ...overrides,
  };
}

test('recognizes explicit completion, no-issue, and successful validation evidence', () => {
  const report = blocked();
  assert.equal(hasCompletionEvidence(report), true);
  assert.equal(hasExplicitNoIssueEvidence(report), true);
  assert.equal(hasSuccessfulCheck(report), true);
  assert.equal(hasUnresolvedBlockerEvidence(report), false);
});

test('reconciles unsupported BLOCKED to CHANGED when the worker changed the workspace', () => {
  const result = reconcileUnsupportedBlockedReport(blocked(), { changed: true, role: 'Worker A' });
  assert.equal(result.report.verdict, 'changed');
  assert.match(result.correction, /BLOCKED -> CHANGED/);
});

test('reconciles unsupported BLOCKED to CLEAN for a read-only reviewer', () => {
  const result = reconcileUnsupportedBlockedReport(blocked({
    summary: 'Current implementation satisfies all requirements. No actionable issues.',
    checks: ['Focused tests passed', 'git diff --check passed'],
  }), { changed: false, role: 'Strong reviewer' });
  assert.equal(result.report.verdict, 'clean');
});

test('completion alone is insufficient to override an explicit BLOCKED verdict', () => {
  const report = blocked({
    summary: 'Implementation is complete.',
    checks: ['Focused tests passed'],
  });
  assert.equal(hasCompletionEvidence(report), true);
  assert.equal(hasExplicitNoIssueEvidence(report), false);
  assert.equal(reconcileUnsupportedBlockedReport(report, { changed: true }).report.verdict, 'blocked');
});

test('preserves genuine missing credential prerequisite BLOCKED', () => {
  const report = blocked({
    summary: 'Implementation is complete, but external validation is unavailable because TASKFLOW_RELEASE_TOKEN is not configured.',
    checks: ['Unit tests passed', 'External validator exited 2: missing TASKFLOW_RELEASE_TOKEN'],
  });
  const result = reconcileUnsupportedBlockedReport(report, { changed: true });
  assert.equal(hasUnresolvedBlockerEvidence(report), true);
  assert.equal(result.report.verdict, 'blocked');
});

test('preserves environmental and execution blocker language even when local checks passed', () => {
  for (const summary of [
    'Implementation is complete, but the required integration service is offline.',
    'Implementation is complete, but the integration check could not run.',
    "Implementation is complete, but the integration check couldn't reach the service.",
    'Implementation is complete, but the required check timed out.',
    'Implementation is complete, but validation hit a permission denied error.',
    'Implementation is complete, but the dependency endpoint is unreachable.',
    'Implementation is complete, but the connection was refused by the required service.',
    'Implementation is complete, but the integration check was skipped because Docker is not running.',
  ]) {
    const report = blocked({ summary, checks: ['Unit tests passed'] });
    assert.equal(hasUnresolvedBlockerEvidence(report), true, summary);
    assert.equal(reconcileUnsupportedBlockedReport(report, { changed: true }).report.verdict, 'blocked', summary);
  }
});

test('preserves BLOCKED when validation failed, findings exist, or completion evidence is absent', () => {
  assert.equal(reconcileUnsupportedBlockedReport(blocked({ checks: ['Unit tests passed', 'Integration validation failed'] }), { changed: true }).report.verdict, 'blocked');
  assert.equal(reconcileUnsupportedBlockedReport(blocked({ findings: ['Fix parser edge case'] }), { changed: true }).report.verdict, 'blocked');
  assert.equal(reconcileUnsupportedBlockedReport(blocked({ summary: 'Work progressed.' }), { changed: true }).report.verdict, 'blocked');
});

test('credential-integrity denial evidence can never be unblocked by report consistency', () => {
  const report = blocked({
    checks: [
      'Unit tests passed',
      'Convergent denied synthetic credential assignment; required validation remains blocked pending operator context.',
    ],
  });
  assert.equal(reconcileUnsupportedBlockedReport(report, { changed: true }).report.verdict, 'blocked');
});
