'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EvidenceObserverRegistry,
} = require('../src/headless/evidence-observers');
const {
  HIGH_RISK_ASSURANCE_TYPED_EVIDENCE,
  HIGH_RISK_ASSURANCE_PEER_FALLBACK,
  HIGH_RISK_ASSURANCE_EXISTING_ROUTE,
  createResearchEvidenceObserverRegistry,
  assuranceDecision,
} = require('../src/headless/high-risk-assurance-policy');

function observer(id, contractId, applicability = () => true) {
  return {
    id,
    evidenceType: `test.${id}`,
    toolName: `custom:test_${id}`,
    auditContract: {
      id: contractId,
      prompt: `audit ${id}`,
      aspects: [['observed', `observe ${id}`]],
    },
    applicability,
    createTool() { return {}; },
    compactEvidence() { return []; },
    augmentReview(review) { return review; },
  };
}

const highRisk = { route: 'high_risk', risk: 'high' };

test('Scenario08-style high-risk path boundary selects typed evidence without peer fallback', () => {
  const decision = assuranceDecision({
    task: {
      title: 'Fix artifact path containment',
      description: 'Fix resolve_artifact_path containment and reject symlink escapes from the artifact root.',
      acceptanceCriteria: [
        'Reject a path component that resolves through a symlink outside the root.',
        'Preserve valid normalized relative artifact paths.',
      ],
    },
    routing: highRisk,
  });

  assert.equal(decision.mode, HIGH_RISK_ASSURANCE_TYPED_EVIDENCE);
  assert.equal(decision.fallbackRequired, false);
  assert.equal(decision.auditContract, 'trust-boundary-composition-v1');
  assert.deepEqual(decision.selectedObservers.map((entry) => entry.id), ['path-resolution-transition-v1']);
});

test('dependency-order task can select its independent typed evidence contract on a high-risk route', () => {
  const decision = assuranceDecision({
    task: {
      title: 'Dependency ordering',
      description: 'Implement order_tasks with deterministic dependency ordering.',
      acceptanceCriteria: [
        'At each topological step choose the earliest original task among tasks currently ready.',
      ],
    },
    routing: highRisk,
  });

  assert.equal(decision.mode, HIGH_RISK_ASSURANCE_TYPED_EVIDENCE);
  assert.equal(decision.auditContract, 'dependency-order-evidence-v2');
  assert.deepEqual(decision.selectedObservers.map((entry) => entry.id), ['dependency-order-ready-transition-v1']);
});

test('high-risk work with no applicable observer retains peer convergence as fail-closed fallback', () => {
  const decision = assuranceDecision({
    task: {
      title: 'Rotate authentication signing keys',
      description: 'Change the production authentication key rotation protocol.',
      acceptanceCriteria: ['Preserve backwards-compatible verification during rotation.'],
    },
    routing: highRisk,
  });

  assert.equal(decision.mode, HIGH_RISK_ASSURANCE_PEER_FALLBACK);
  assert.equal(decision.fallbackRequired, true);
  assert.equal(decision.reason, 'no-applicable-typed-observer');
  assert.deepEqual(decision.selectedObservers, []);
});

test('observer applicability errors fail closed to peer convergence', () => {
  const registry = new EvidenceObserverRegistry([
    observer('broken', 'broken-v1', () => { throw new Error('selector exploded'); }),
  ]);
  const decision = assuranceDecision({ task: { title: 'high risk' }, routing: highRisk, registry });

  assert.equal(decision.mode, HIGH_RISK_ASSURANCE_PEER_FALLBACK);
  assert.equal(decision.fallbackRequired, true);
  assert.match(decision.applicability[0].reason, /applicability-error:selector exploded/);
});

test('selected observers with incompatible audit contracts fail closed to peer convergence', () => {
  const registry = new EvidenceObserverRegistry([
    observer('first', 'contract-a'),
    observer('second', 'contract-b'),
  ]);
  const decision = assuranceDecision({ task: { title: 'high risk' }, routing: highRisk, registry });

  assert.equal(decision.mode, HIGH_RISK_ASSURANCE_PEER_FALLBACK);
  assert.equal(decision.fallbackRequired, true);
  assert.equal(decision.reason, 'incompatible-observer-audit-contracts');
  assert.match(decision.error, /incompatible audit contracts/i);
  assert.deepEqual(decision.selectedObservers.map((entry) => entry.id), ['first', 'second']);
});

test('registry selection failures fail closed instead of weakening assurance', () => {
  const decision = assuranceDecision({
    task: { title: 'high risk' },
    routing: highRisk,
    registry: { selectApplicable() { throw new Error('registry unavailable'); } },
  });

  assert.equal(decision.mode, HIGH_RISK_ASSURANCE_PEER_FALLBACK);
  assert.equal(decision.fallbackRequired, true);
  assert.equal(decision.reason, 'observer-selection-failed');
  assert.match(decision.error, /registry unavailable/);
});

test('non-high-risk tasks preserve existing routing and do not pay observer-selection cost', () => {
  const registry = {
    selectApplicable() {
      throw new Error('must not be called');
    },
  };
  const decision = assuranceDecision({
    task: { title: 'ordinary code change' },
    routing: { route: 'standard', risk: 'medium' },
    registry,
  });

  assert.equal(decision.mode, HIGH_RISK_ASSURANCE_EXISTING_ROUTE);
  assert.equal(decision.fallbackRequired, false);
  assert.equal(decision.reason, 'task-is-not-on-high-risk-route');
});

test('research registry contains both independently proven observer domains', () => {
  const registry = createResearchEvidenceObserverRegistry();
  assert.deepEqual(registry.metadata().map((entry) => entry.id).sort(), [
    'dependency-order-ready-transition-v1',
    'path-resolution-transition-v1',
  ]);
});
