'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePassReport,
  validatePassReport,
  normalizeReviewReport,
  validateReviewReport,
} = require('../src/copilot/tools');

test('worker verdicts are trimmed and normalized case-insensitively', () => {
  for (const raw of ['CHANGED', ' changed ', 'CLEAN', ' clean ', 'BLOCKED']) {
    const report = normalizePassReport({ verdict: raw, summary: 'ok', findings: [], checks: [] });
    assert.equal(report.verdict, raw.trim().toLowerCase());
    assert.equal(validatePassReport(report), null);
  }
});

test('review verdicts are trimmed and normalized case-insensitively', () => {
  for (const raw of ['CLEAN', ' clean ', 'BLOCKED']) {
    const report = normalizeReviewReport({ verdict: raw, summary: 'ok', findings: [], checks: [] });
    assert.equal(report.verdict, raw.trim().toLowerCase());
    assert.equal(validateReviewReport(report), null);
  }
  const findings = normalizeReviewReport({
    verdict: ' FINDINGS ',
    summary: 'issue',
    findings: [{ severity: 'high', title: 'x', description: 'y' }],
    checks: [],
  });
  assert.equal(findings.verdict, 'findings');
  assert.equal(validateReviewReport(findings), null);
});

test('unknown structured verdicts fail validation instead of silently becoming BLOCKED', () => {
  const pass = normalizePassReport({ verdict: 'MAYBE', summary: 'ambiguous', findings: [], checks: [] });
  const review = normalizeReviewReport({ verdict: 'APPROVE', summary: 'ambiguous', findings: [], checks: [] });
  assert.equal(pass.verdict, 'maybe');
  assert.match(validatePassReport(pass), /verdict/i);
  assert.equal(review.verdict, 'approve');
  assert.match(validateReviewReport(review), /verdict/i);
});
