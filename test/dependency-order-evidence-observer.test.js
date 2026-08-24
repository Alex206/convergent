'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEPENDENCY_ORDER_OBSERVER_ID,
  DEPENDENCY_ORDER_AUDIT_CONTRACT,
  REVIEW_AUDITOR_DEPENDENCY_PROMPT,
  dependencyOrderObserverApplicability,
  compactDependencyEvidence,
  augmentReviewWithDependencyEvidence,
  createDependencyOrderEvidenceObserver,
} = require('../src/headless/dependency-order-evidence-observer');
const { EvidenceObserverRegistry } = require('../src/headless/evidence-observers');

test('dependency-order observer declares a separate typed graph audit contract', () => {
  const observer = createDependencyOrderEvidenceObserver();
  assert.equal(observer.id, DEPENDENCY_ORDER_OBSERVER_ID);
  assert.equal(observer.evidenceType, 'graph.dependency-order-ready-transition');
  assert.equal(observer.auditContract.id, 'dependency-order-evidence-v1');
  assert.equal(DEPENDENCY_ORDER_AUDIT_CONTRACT.aspects.length, 7);
  assert.match(REVIEW_AUDITOR_DEPENDENCY_PROMPT, /ready_transition_trace/);
  assert.equal(observer.metadata.graphReadySetEvidence, true);
});

test('dependency-order applicability requires explicit stable dependency-order semantics', () => {
  const task = {
    title: 'Add dependency ordering',
    description: 'Add order_tasks(tasks) in deterministic dependency order.',
    acceptanceCriteria: ['Preserve original input order whenever dependencies do not constrain two tasks.'],
  };
  assert.equal(dependencyOrderObserverApplicability({ task }).applicable, true);
  assert.equal(dependencyOrderObserverApplicability({
    task: {
      title: 'Fix artifact path containment',
      description: 'Reject symlink escapes from root.',
    },
  }).applicable, false);
});

test('dependency evidence is exact-revision bounded and review augmentation is explicit', () => {
  const observations = [
    { revision: 'old', spec: { cases: [{ label: 'old' }] }, result: { results: [{ label: 'old' }] } },
    { revision: 'current', spec: { cases: [{ label: 'fresh' }] }, result: { results: [{ label: 'fresh' }] } },
  ];
  const compact = compactDependencyEvidence(observations, 'current');
  assert.equal(compact.length, 1);
  assert.equal(compact[0].cases[0].label, 'fresh');

  const review = augmentReviewWithDependencyEvidence({ checks: ['base'] }, compact, 'current-revision');
  assert.equal(review.checks.length, 2);
  assert.match(review.checks[1], /PROGRAMMATIC DEPENDENCY-ORDER EVIDENCE/);
  assert.match(review.checks[1], /current-revision/);
  assert.match(review.checks[1], /fresh/);
});

test('registry selects path and dependency capabilities independently', () => {
  const { createPathResolutionTransitionObserver } = require('../src/headless/evidence-observers');
  const registry = new EvidenceObserverRegistry([
    createPathResolutionTransitionObserver(),
    createDependencyOrderEvidenceObserver(),
  ]);

  const dependency = registry.selectApplicable({
    task: {
      title: 'Dependency ordering',
      description: 'Add order_tasks with deterministic dependency order.',
      acceptanceCriteria: ['Preserve original input order for unconstrained tasks.'],
    },
    routing: { route: 'standard' },
  });
  assert.deepEqual(dependency.registry.metadata().map((entry) => entry.id), [DEPENDENCY_ORDER_OBSERVER_ID]);
  assert.equal(dependency.registry.auditContract().id, 'dependency-order-evidence-v1');

  const path = registry.selectApplicable({
    task: {
      title: 'Artifact path containment',
      description: 'Fix resolve_artifact_path root containment.',
      acceptanceCriteria: ['Reject symlink escapes.'],
    },
    routing: { route: 'high_risk' },
  });
  assert.deepEqual(path.registry.metadata().map((entry) => entry.id), ['path-resolution-transition-v1']);
  assert.equal(path.registry.auditContract().id, 'trust-boundary-composition-v1');
});
