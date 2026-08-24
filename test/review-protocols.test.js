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

test('perspective panel reviews one exact revision independently before one bounded remediation', async () => {
  const engine = Object.create(PerspectivePanelTopologyEngine.prototype);
  const events = [];
  const worker = { session: { id: 'worker' }, model: { id: 'gpt-5.6-luna' }, reasoningEffort: 'medium' };
  const strongReviewer = { session: { id: 'terra' }, model: { id: 'gpt-5.6-terra' }, reasoningEffort: 'high' };
  const panelById = new Map();
  const factory = {
    async createWorker() { return worker; },
    async createPanelReviewer(_taskId, spec) {
      const reviewer = {
        session: { id: `panel-${spec.id}` },
        model: { id: 'gpt-5.6-luna' },
        reasoningEffort: 'medium',
        panelReviewer: spec,
      };
      panelById.set(spec.id, reviewer);
      return reviewer;
    },
    async createReviewer() { return strongReviewer; },
  };

  engine.sessions = [];
  engine.topologyConfig = { panelMode: 'perspective' };
  engine.ui = {
    agentConfiguration() {},
    passResult() {},
    phase(name, detail) { events.push({ type: 'phase', name, detail }); },
  };
  engine.revisionProvider = async () => 'revision-1';
  engine.runWorkerPass = async (_agent, _task, mode, findings) => {
    events.push({ type: 'worker', mode, findings });
    return {
      report: { verdict: 'changed', summary: mode, findings: [], checks: [] },
      changed: true,
      revision: 'revision-1',
    };
  };
  engine.resolveSingleWorkerPass = async () => ({ evidence: [{ command: 'unit-tests', ok: true }] });
  engine.runPanelReviewPass = async (reviewer, _task, evidence, revision) => {
    events.push({
      type: 'panel',
      id: reviewer.panelReviewer.id,
      revision,
      evidence,
    });
    if (reviewer.panelReviewer.id === 'adversarial') {
      return {
        verdict: 'findings',
        summary: 'one falsifying witness',
        findings: [{ severity: 'high', title: 'counterexample', description: 'witness' }],
      };
    }
    return { verdict: 'clean', summary: 'clean in charter', findings: [] };
  };
  engine.saveTaskCheckpoint = async () => {};
  engine.checkAiCreditBudget = async () => {};
  engine.runStrongReview = async (_task, _workerA, _workerB, reviewer, evidence) => {
    events.push({ type: 'strong-review', reviewer, evidence });
  };
  engine.disposeTaskSessions = async (sessions) => {
    events.push({ type: 'dispose', sessions });
  };

  await engine.runPanelTask(
    factory,
    { id: 'task-1', description: 'benchmark task' },
    'task-1',
    { route: 'standard', risk: 'high' },
    'perspective',
  );

  const panelEvents = events.filter((event) => event.type === 'panel');
  assert.deepEqual(panelEvents.map((event) => event.id), ['contract', 'adversarial', 'state']);
  assert.ok(panelEvents.every((event) => event.revision === 'revision-1'));
  assert.ok(panelEvents.every((event) => event.evidence.length === 1));
  assert.equal(panelById.size, 3);

  const workerEvents = events.filter((event) => event.type === 'worker');
  assert.deepEqual(workerEvents.map((event) => event.mode), ['IMPLEMENT', 'FIX_REVIEW_PANEL_FINDINGS']);
  assert.equal(workerEvents[1].findings.length, 1);

  const strongReviews = events.filter((event) => event.type === 'strong-review');
  assert.equal(strongReviews.length, 1);
  assert.equal(strongReviews[0].reviewer, strongReviewer);

  const disposed = events.find((event) => event.type === 'dispose');
  assert.equal(disposed.sessions.length, 5);
});