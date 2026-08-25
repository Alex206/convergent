'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CASES } = require('../src/headless/reviewer-v7-case-validation');
const { matchesDefect, summarize } = require('../src/headless/reviewer-v7-report');

test('V7 uses three distinct real historical latent regressions', () => {
  assert.deepEqual(Object.keys(CASES), [
    'v7-h15-latent-report-integrity',
    'v7-h22-latent-turn-budget',
    'v7-h23-latent-ci-gate',
  ]);
});

test('V7 matchers identify the historical mechanisms without generic issue overmatch', () => {
  assert.equal(matchesDefect('successful_validation_negative_case_false_positive', {
    title: 'Successful external validation is reclassified as blocked',
    description: 'A passing validator plus expected missing-token negative-case wording is misclassified as an unresolved blocker.',
  }), true);
  assert.equal(matchesDefect('accepted_report_order_invariance', {
    title: 'Late usage event breaches turn cap after accepted report',
    description: 'When report_pass completes before assistant_usage for the capped call, the accepted structured report is treated as a budget breach.',
  }), true);
  assert.equal(matchesDefect('oracle_failure_propagates', {
    title: 'Failed acceptance oracle can leave CI green',
    description: 'continue-on-error swallows a non-zero independent benchmark validation result instead of failing the job.',
  }), true);
  assert.equal(matchesDefect('oracle_failure_propagates', {
    title: 'Rename workflow step',
    description: 'The current label is verbose.',
  }), false);
});

test('V7 scoring derives individual opportunities from actual panel size', () => {
  const makeRun = (arm, reviewerCount, hitCount, credits) => ({
    arm,
    caseId: 'case',
    reviewerCount,
    expectedDefects: ['d'],
    detectedDefects: hitCount ? ['d'] : [],
    reviewerHits: { d: Array.from({ length: hitCount }, (_, index) => `r${index + 1}`) },
    usage: { aiCredits: credits, calls: reviewerCount * 4, inputTokens: reviewerCount * 1000 },
  });
  const summary = summarize([
    makeRun('luna-broad-1', 1, 1, 1),
    makeRun('luna-broad-2', 2, 1, 2),
    makeRun('luna-broad-3', 3, 2, 3),
  ]);
  assert.deepEqual(summary.map((entry) => [entry.arm, entry.individualHits, entry.individualOpportunities]), [
    ['luna-broad-1', 1, 1],
    ['luna-broad-2', 1, 2],
    ['luna-broad-3', 2, 3],
  ]);
});
