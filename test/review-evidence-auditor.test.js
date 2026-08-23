'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_MAX_REVIEW_AUDIT_ROUNDS,
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
    matched_contrast_pair: true,
    overrestriction_guard: true,
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

test('matched benign evidence must guard against over-restrictive remediation', () => {
  const weak = completeAudit({
    matched_contrast_pair: false,
    overrestriction_guard: false,
    summary: 'The benign case is ordinary normalization rather than a matched counterpart.',
    missing_or_weak_aspects: [
      'Benign evidence does not exercise the corresponding permitted transition shape.',
      'The benign witness would not expose a remediation that rejects the whole transition family.',
    ],
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

test('auditor feedback targets reviewer evidence and matched counterexamples rather than assuming a code defect', () => {
  const weak = completeAudit({
    transition_sequence_tested: false,
    hostile_composition_observed: false,
    matched_contrast_pair: false,
    overrestriction_guard: false,
    summary: 'Only final-state evidence was reported.',
    missing_or_weak_aspects: ['No hostile transitional witness was exercised.'],
  });
  const feedback = auditFeedback(weak);
  assert.match(feedback, /review-quality retry/i);
  assert.match(feedback, /not evidence that the implementation is defective/i);
  assert.match(feedback, /No hostile transitional witness/i);
  assert.match(feedback, /matched semantic counterpart/i);
  assert.match(feedback, /capable of falsifying an over-restrictive implementation/i);
});

test('auditor allows a third bounded challenge after remediation', () => {
  assert.equal(DEFAULT_MAX_REVIEW_AUDIT_ROUNDS, 3);
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
