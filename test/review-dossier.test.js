'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { appendReviewDossier, formatReviewDossier, normalizeReviewDossier } = require('../src/orchestrator/review-dossier');

test('review dossier keeps explicit review results and cycle usage', () => {
  const dossier = appendReviewDossier(null, {
    cycle: 3,
    revision: 'R3',
    report: {
      verdict: 'findings',
      summary: 'One issue remains',
      findings: [{ severity: 'high', title: 'Race', description: 'Fix ordering', file: 'src/a.js' }],
      checks: ['npm test passed'],
    },
    tools: [{ toolName: 'builtin:bash', detail: 'npm test', success: true }],
    usage: { inputTokens: 1200, outputTokens: 80, reasoningTokens: 200, aiCredits: 0.12, hasCreditData: true },
  });

  assert.equal(dossier.cycles.length, 1);
  assert.equal(dossier.cycles[0].cycle, 3);
  assert.equal(dossier.cycles[0].usage.inputTokens, 1200);
  assert.match(formatReviewDossier(dossier), /R3/);
  assert.match(formatReviewDossier(dossier), /npm test/);
  assert.match(formatReviewDossier(dossier), /structured review history/i);
});

test('review dossier replaces the same cycle instead of duplicating it', () => {
  let dossier = appendReviewDossier(null, { cycle: 2, revision: 'A', verdict: 'blocked', summary: 'first' });
  dossier = appendReviewDossier(dossier, { cycle: 2, revision: 'B', verdict: 'clean', summary: 'retry succeeded' });
  const normalized = normalizeReviewDossier(dossier);
  assert.equal(normalized.cycles.length, 1);
  assert.equal(normalized.cycles[0].revision, 'B');
  assert.equal(normalized.cycles[0].verdict, 'clean');
});