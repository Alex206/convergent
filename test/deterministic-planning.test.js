'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deterministicPlanningDecision,
  deterministicSingleTaskPlan,
} = require('../src/orchestrator/deterministic-planning');

test('forms one deterministic standard task for an explicit cohesive implementation request', () => {
  const request = 'Extend TaskFlow with configurable retry backoff. Add retry_backoff_seconds to TaskSpec with a default of 0. The config parser must accept a non-negative integer value and preserve backwards compatibility. Each Attempt must expose delay_before_seconds. Add focused unittest coverage and do not change unrelated behavior.';
  const decision = deterministicPlanningDecision(request);
  assert.equal(decision.eligible, true);
  assert.equal(decision.plan.tasks.length, 1);
  assert.equal(decision.plan.tasks[0].description, request);
  assert.equal(decision.plan.tasks[0].route, 'standard');
  assert.equal(decision.plan.tasks[0].risk, 'medium');
  assert.equal(decision.plan.tasks[0].architectureSignificance, 'low');
  assert.equal(decision.routing.peerConvergence, false);
});

test('cohesive high-risk request can skip persistent planning but is still upgraded deterministically', () => {
  const decision = deterministicPlanningDecision('Fix authentication token validation so expired credentials are rejected and add focused tests.');
  assert.equal(decision.eligible, true);
  assert.equal(decision.plan.tasks[0].route, 'high_risk');
  assert.equal(decision.plan.tasks[0].risk, 'high');
  assert.equal(decision.routing.peerConvergence, true);
});

test('security fix that preserves the public API can skip planning while retaining high-risk assurance', () => {
  const decision = deterministicPlanningDecision('Fix the security boundary in the artifact-path resolver. Preserve the public API and existing valid-path behavior, reject escaping paths, and add focused regression tests.');
  assert.equal(decision.eligible, true);
  assert.equal(decision.plan.tasks.length, 1);
  assert.equal(decision.plan.tasks[0].route, 'high_risk');
  assert.equal(decision.plan.tasks[0].risk, 'high');
  assert.equal(decision.routing.peerConvergence, true);
});

test('explicit operator credential variable forces high-risk assurance without requiring planner inference', () => {
  const decision = deterministicPlanningDecision('Update release signing so the required external validation uses TASKFLOW_RELEASE_TOKEN and add focused tests.');
  assert.equal(decision.eligible, true);
  assert.equal(decision.plan.tasks[0].route, 'high_risk');
  assert.equal(decision.plan.tasks[0].risk, 'high');
  assert.equal(decision.routing.peerConvergence, true);
  assert.match(decision.plan.tasks[0].routingReason, /credential variable/i);
});

test('explicit full-routing mode is preserved by deterministic task formation', () => {
  const decision = deterministicPlanningDecision('Implement retry backoff in the existing client and add focused tests.', 'full');
  assert.equal(decision.eligible, true);
  assert.equal(decision.plan.tasks[0].route, 'standard');
  assert.equal(decision.routing.peerConvergence, true);
});

test('read-only and question-style requests retain the strong coordinator', () => {
  for (const request of [
    'Explain how retry backoff currently works.',
    'How can I fix retry backoff without changing compatibility?',
    'Compare the current retry implementations and recommend one.',
    'Investigate why the retry test is flaky.',
  ]) {
    const decision = deterministicPlanningDecision(request);
    assert.equal(decision.eligible, false, request);
    assert.equal(deterministicSingleTaskPlan(request), null);
  }
});

test('unresolved design choices retain the strong coordinator', () => {
  for (const request of [
    'Choose between Redis and SQLite and implement the best approach.',
    'Evaluate approaches for caching and then add the selected design.',
    'Design an architecture for multiple runtime backends and implement it.',
  ]) {
    assert.equal(deterministicPlanningDecision(request).eligible, false, request);
  }
});

test('high architecture significance retains strong planning before conditional architect', () => {
  const decision = deterministicPlanningDecision('Introduce a runtime abstraction and backend provider boundary while preserving current behavior.');
  assert.equal(decision.eligible, false);
  assert.match(decision.reason, /architecture significance/i);
});

test('obviously decomposed multi-task requests retain strong planning', () => {
  const numbered = '1. Add retry backoff to TaskFlow.\n2. Replace the unrelated logging backend.';
  const bullets = '- Add retry backoff.\n- Replace the logging backend.';
  assert.equal(deterministicPlanningDecision(numbered).eligible, false);
  assert.equal(deterministicPlanningDecision(bullets).eligible, false);
});

test('actual high-impact public/release boundary changes retain strong planning', () => {
  assert.equal(deterministicPlanningDecision('Change the public API compatibility contract and add tests.').eligible, false);
  assert.equal(deterministicPlanningDecision('Redesign the public API and update callers.').eligible, false);
  assert.equal(deterministicPlanningDecision('Update the production release pipeline and add validation.').eligible, false);
});

test('request text is preserved verbatim as the task objective', () => {
  const request = 'Fix parser whitespace handling. Preserve " 1 s " as invalid; add a focused regression test.';
  const direct = deterministicSingleTaskPlan(request);
  assert.equal(direct.plan.tasks[0].description, request);
  assert.match(direct.plan.tasks[0].acceptanceCriteria[0], /complete user request/i);
});
