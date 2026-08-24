'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDefaultEvidenceObserverRegistry,
  ProbeEnabledReviewEvidenceAuditorSessionFactory,
} = require('../src/headless/review-evidence-auditor-cli');

test('default experimental registry exposes both typed capabilities but selects one per task', () => {
  const registry = createDefaultEvidenceObserverRegistry();
  assert.deepEqual(registry.metadata().map((entry) => entry.id).sort(), [
    'dependency-order-ready-transition-v1',
    'path-resolution-transition-v1',
  ]);

  const dependency = registry.selectApplicable({
    task: {
      title: 'Task dependencies',
      description: 'Add order_tasks in deterministic dependency order.',
      acceptanceCriteria: ['Choose the earliest original-input task among tasks that are currently dependency-ready.'],
    },
    routing: { route: 'standard' },
  });
  assert.deepEqual(dependency.registry.metadata().map((entry) => entry.id), ['dependency-order-ready-transition-v1']);
  assert.equal(dependency.registry.auditContract().id, 'dependency-order-evidence-v2');
});

test('session factory switches audit contract when an observer is selected', () => {
  const factory = Object.create(ProbeEnabledReviewEvidenceAuditorSessionFactory.prototype);
  factory.defaultReviewAuditContract = { id: 'default' };
  factory.availableEvidenceObservers = createDefaultEvidenceObserverRegistry();
  factory.evidenceObservers = null;
  factory.evidenceObservationState = null;
  factory.evidenceObserverApplicability = [];
  factory.reviewAuditContract = factory.defaultReviewAuditContract;

  const decisions = factory.configureEvidenceObservers({
    task: {
      title: 'Dependency ordering',
      description: 'Implement order_tasks with stable deterministic dependency ordering.',
      acceptanceCriteria: ['At each step choose the earliest original-input task among tasks whose dependencies are already emitted.'],
    },
    routing: { route: 'standard' },
  });

  assert.ok(decisions.some((entry) => entry.observerId === 'dependency-order-ready-transition-v1' && entry.applicable));
  assert.equal(factory.reviewAuditContract.id, 'dependency-order-evidence-v2');
  assert.deepEqual(factory.evidenceObservers.metadata().map((entry) => entry.id), ['dependency-order-ready-transition-v1']);
});
