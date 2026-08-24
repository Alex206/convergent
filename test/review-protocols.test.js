'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PANEL_REVIEWER_COMMON_PROMPT,
  GENERIC_REVIEW_PROMPT,
  PERSPECTIVE_PROTOCOLS,
  panelReviewersForMode,
} = require('../src/headless/review-protocols');
const {
  topologyConfig,
  topologyNames,
  applyTopologySelectors,
} = require('../src/headless/topology');
const {
  PerspectivePanelSessionFactory,
  PerspectivePanelTopologyEngine,
} = require('../src/headless/perspective-topology-engine');
const {
  LeanStandardSessionFactory,
  BenchmarkTopologyEngine,
} = require('../src/headless/topology-engine');

test('generic panel is a same-budget three-reviewer control with identical charter', () => {
  const reviewers = panelReviewersForMode('generic');
  assert.equal(reviewers.length, 3);
  assert.deepEqual(reviewers.map((entry) => entry.id), ['generic-1', 'generic-2', 'generic-3']);
  assert.ok(reviewers.every((entry) => entry.prompt === GENERIC_REVIEW_PROMPT));
});

test('perspective panel assigns complementary reusable review charters', () => {
  const reviewers = panelReviewersForMode('perspective');
  assert.deepEqual(reviewers.map((entry) => entry.id), ['contract', 'adversarial', 'state']);
  assert.equal(new Set(reviewers.map((entry) => entry.prompt)).size, 3);
  assert.match(PERSPECTIVE_PROTOCOLS.contract.prompt, /positive, negative, boundary, and compatibility claims/);
  assert.match(PERSPECTIVE_PROTOCOLS.adversarial.prompt, /make a plausible implementation fail/);
  assert.match(PERSPECTIVE_PROTOCOLS.state.prompt, /throughout execution, not only in the final returned value/);
});

test('review protocols remain generic rather than encoding Scenario 08 oracle answers', () => {
  const text = [
    PANEL_REVIEWER_COMMON_PROMPT,
    GENERIC_REVIEW_PROMPT,
    ...Object.values(PERSPECTIVE_PROTOCOLS).map((entry) => entry.prompt),
  ].join('\n');
  assert.doesNotMatch(text, /symlink/i);
  assert.doesNotMatch(text, /escape\/\.\.\/work/i);
  assert.doesNotMatch(text, /scenario\s*0?8/i);
  assert.doesNotMatch(text, /artifact[_ -]?path[_ -]?containment/i);
});

test('unsupported panel mode fails closed', () => {
  assert.throws(() => panelReviewersForMode('mystery'), /Unsupported review panel mode/);
});

test('panel topologies are benchmark-only and keep model spend comparable', () => {
  const generic = topologyConfig('luna-generic-panel-terra');
  const perspective = topologyConfig('luna-perspective-panel-terra');
  assert.equal(generic.benchmarkOnly, true);
  assert.equal(perspective.benchmarkOnly, true);
  assert.equal(generic.panelMode, 'generic');
  assert.equal(perspective.panelMode, 'perspective');
  assert.deepEqual(generic.selectors, perspective.selectors);
  assert.equal(generic.selectors.workerA, 'gpt-5.6-luna');
  assert.equal(generic.selectors.workerB, 'gpt-5.6-luna');
  assert.equal(generic.selectors.reviewer, 'gpt-5.6-terra');
  assert.ok(!topologyNames().includes('luna-generic-panel-terra'));
  assert.ok(!topologyNames().includes('luna-perspective-panel-terra'));
});

test('panel topology selectors pin all panel reviewers to Luna', () => {
  const selected = applyTopologySelectors({ topology: 'luna-perspective-panel-terra' });
  assert.equal(selected.workerA, 'gpt-5.6-luna');
  assert.equal(selected.workerB, 'gpt-5.6-luna');
  assert.equal(selected.reviewer, 'gpt-5.6-terra');
});

test('panel engine extends benchmark machinery without changing production engine', () => {
  assert.ok(PerspectivePanelSessionFactory.prototype instanceof LeanStandardSessionFactory);
  assert.ok(PerspectivePanelTopologyEngine.prototype instanceof BenchmarkTopologyEngine);
});
