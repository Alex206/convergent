'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REVIEW_PROTOCOLS,
  REVIEW_PROTOCOL_IDS,
  MAX_SELECTED_PROTOCOLS,
  GENERIC_LUNA_REVIEW_PROMPT,
  REVIEW_CONTROLLER_PROMPT,
  formatReviewProtocolCatalog,
  normalizeReviewPlan,
  validateReviewPlan,
  createReviewPlanTool,
  perspectiveSystemPrompt,
  formatPanelReports,
} = require('../src/headless/review-protocols');

const BENCHMARK_SPECIFIC_MARKERS = [
  'scenario03',
  'scenario08',
  'resolve_artifact_path',
  'symlink_escape_reentry',
  'escape/../',
  'path-resolution-transition',
  'dependency-order-evidence',
  'stable topological ready-set',
];

test('review protocol catalog is fixed, complementary, and benchmark-agnostic', () => {
  assert.deepEqual(REVIEW_PROTOCOL_IDS, [
    'contract',
    'adversarial',
    'state-dataflow',
    'integration-compatibility',
    'security-trust',
    'concurrency-resources',
  ]);
  assert.equal(MAX_SELECTED_PROTOCOLS, 3);

  const text = [
    formatReviewProtocolCatalog(),
    GENERIC_LUNA_REVIEW_PROMPT,
    REVIEW_CONTROLLER_PROMPT,
    ...REVIEW_PROTOCOL_IDS.map((id) => perspectiveSystemPrompt(id)),
  ].join('\n').toLowerCase();

  for (const marker of BENCHMARK_SPECIFIC_MARKERS) {
    assert.equal(text.includes(marker), false, `review protocol text must not encode benchmark marker ${marker}`);
  }

  for (const id of REVIEW_PROTOCOL_IDS) {
    assert.ok(REVIEW_PROTOCOLS[id].label);
    assert.ok(REVIEW_PROTOCOLS[id].charter.length > 100);
  }
});

test('review plan requires exactly three unique known protocols', () => {
  const valid = normalizeReviewPlan({
    selected: ['contract', 'adversarial', 'security-trust'],
    rationale: 'Complementary requirement, falsification, and trust-boundary coverage.',
  });
  assert.equal(validateReviewPlan(valid), null);

  assert.match(validateReviewPlan({ ...valid, selected: ['contract', 'adversarial'] }), /exactly 3/);
  assert.match(validateReviewPlan({ ...valid, selected: ['contract', 'contract', 'security-trust'] }), /unique/);
  assert.match(validateReviewPlan({ ...valid, selected: ['contract', 'adversarial', 'made-up'] }), /Unknown/);
  assert.match(validateReviewPlan({ ...valid, rationale: '' }), /rationale/);
});

test('review plan tool validates selections before accepting them', async () => {
  const sink = { value: null };
  let definition;
  const defineTool = (name, spec) => {
    definition = { name, ...spec };
    return definition;
  };
  createReviewPlanTool(defineTool, sink);
  assert.equal(definition.name, 'report_review_plan');

  const rejected = await definition.handler({
    selected: ['contract', 'contract', 'security-trust'],
    rationale: 'Duplicate on purpose.',
  });
  assert.equal(rejected.accepted, false);
  assert.equal(sink.value, null);

  const accepted = await definition.handler({
    selected: ['contract', 'state-dataflow', 'integration-compatibility'],
    rationale: 'Covers semantics, state, and consumers.',
  });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(sink.value.selected, ['contract', 'state-dataflow', 'integration-compatibility']);
});

test('panel report formatting preserves independent reviewer identity and findings', () => {
  const text = formatPanelReports([
    {
      label: 'contract',
      report: {
        verdict: 'findings',
        summary: 'One contract mismatch.',
        findings: [{ severity: 'high', title: 'Mismatch', description: 'Requirement is not preserved.', file: 'a.js' }],
        checks: ['inspected caller'],
      },
    },
    {
      label: 'security-trust',
      report: { verdict: 'clean', summary: 'No trust-boundary defect.', findings: [], checks: [] },
    },
  ]);
  assert.match(text, /Reviewer: contract/);
  assert.match(text, /\[high\] Mismatch \(a\.js\)/);
  assert.match(text, /Reviewer: security-trust/);
  assert.match(text, /findings:\n  - none/);
});
