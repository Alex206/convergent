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

test('report-prose helpers remain available for diagnostics', () => {
  const report = blocked();
  assert.equal(hasCompletionEvidence(report), true);
  assert.equal(hasExplicitNoIssueEvidence(report), true);
  assert.equal(hasSuccessfulCheck(report), true);
  assert.equal(hasUnresolvedBlockerEvidence(report), false);
});

test('structured BLOCKED is not rewritten from completion/no-issue prose', () => {
  for (const changed of [false, true]) {
    const result = reconcileUnsupportedBlockedReport(blocked(), { changed, role: changed ? 'Worker A' : 'Strong reviewer' });
    assert.equal(result.report.verdict, 'blocked');
    assert.equal(result.correction, null);
  }
});

test('structured BLOCKED remains authoritative even when prose appears inconsistent', () => {
  const report = blocked({
    summary: 'Current implementation satisfies all requirements. No actionable issues.',
    checks: ['Focused tests passed', 'git diff --check passed'],
  });
  assert.equal(reconcileUnsupportedBlockedReport(report, { changed: true }).report.verdict, 'blocked');
});

test('diagnostic blocker helper still recognizes environmental failure language', () => {
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

test('findings/check content never changes a structured BLOCKED verdict', () => {
  assert.equal(reconcileUnsupportedBlockedReport(blocked({ checks: ['Unit tests passed', 'Integration validation failed'] }), { changed: true }).report.verdict, 'blocked');
  assert.equal(reconcileUnsupportedBlockedReport(blocked({ findings: ['Fix parser edge case'] }), { changed: true }).report.verdict, 'blocked');
  assert.equal(reconcileUnsupportedBlockedReport(blocked({ summary: 'Work progressed.' }), { changed: true }).report.verdict, 'blocked');
});

test('credential-integrity prose also remains diagnostic; hard credential guard owns deterministic enforcement', () => {
  const report = blocked({
    checks: [
      'Unit tests passed',
      'Convergent denied synthetic credential assignment; required validation remains blocked pending operator context.',
    ],
  });
  assert.equal(reconcileUnsupportedBlockedReport(report, { changed: true }).report.verdict, 'blocked');
});
