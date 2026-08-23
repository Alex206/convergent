'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAuditReport,
  validateAuditReport,
  auditFeedback,
  compactTaskForAudit,
} = require('../src/headless/review-evidence-auditor');

function completeAudit(overrides = {}) {
  return normalizeAuditReport({
    boundary_identified: true,
    transition_sequence_tested: true,
    hostile_composition_observed: true,
    benign_composition_observed: true,
    discriminating_evidence: true,
    summary: 'All required evidence is explicit.',
    missing_or_weak_aspects: [],
    ...overrides,
  });
}

test('review evidence audit derives adequate only when every semantic aspect is explicit', () => {
  const adequate = completeAudit();
  assert.equal(adequate.adequate, true);
  assert.equal(validateAuditReport(adequate), null);

  const weak = completeAudit({
    hostile_composition_observed: false,
    summary: 'Hostile composition evidence is too generic.',
    missing_or_weak_aspects: ['No observed hostile transition composition is recorded.'],
  });
  assert.equal(weak.adequate, false);
  assert.equal(validateAuditReport(weak), null);
});

test('review evidence audit rejects internally inconsistent structured reports', () => {
  const inadequateWithoutGap = completeAudit({
    benign_composition_observed: false,
    missing_or_weak_aspects: [],
  });
  assert.match(validateAuditReport(inadequateWithoutGap), /requires at least one/i);

  const adequateWithGap = completeAudit({
    missing_or_weak_aspects: ['Contradictory gap'],
  });
  assert.match(validateAuditReport(adequateWithGap), /requires missing_or_weak_aspects=\[\]/i);
});

test('auditor feedback targets reviewer evidence rather than assuming a code defect', () => {
  const weak = completeAudit({
    transition_sequence_tested: false,
    hostile_composition_observed: false,
    summary: 'Only final-state evidence was reported.',
    missing_or_weak_aspects: ['No hostile transitional witness was exercised.'],
  });
  const feedback = auditFeedback(weak);
  assert.match(feedback, /review-quality retry/i);
  assert.match(feedback, /not evidence that the implementation is defective/i);
  assert.match(feedback, /No hostile transitional witness/i);
});

test('audit task context is deliberately bounded', () => {
  const compact = compactTaskForAudit({
    title: 'Boundary task',
    description: 'x'.repeat(4000),
    acceptanceCriteria: Array.from({ length: 20 }, (_, index) => `criterion-${index}`),
  });
  assert.equal(compact.description.length, 1800);
  assert.equal(compact.acceptanceCriteria.length, 12);
});
