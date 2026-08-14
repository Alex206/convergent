'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { preserveRequestArchitectureSignificance } = require('../src/orchestrator/engine');
const { normalizeTaskRoute } = require('../src/orchestrator/routing');

function task(id, overrides = {}) {
  return {
    id,
    title: `Task ${id}`,
    description: 'Implement the planned local change.',
    acceptanceCriteria: ['Behavior is preserved'],
    route: 'standard',
    risk: 'medium',
    routingReason: 'coordinator paraphrase',
    ...overrides,
  };
}

test('single modifying coordinator task preserves architecture-high semantics from original request', () => {
  const plan = { summary: 'one task', tasks: [task('one')] };
  const result = preserveRequestArchitectureSignificance(
    plan,
    'Refactor the ownership boundary between model state and reporting while preserving behavior.',
  );
  assert.equal(result.changed, true);
  assert.equal(result.requiresCoordinatorCorrection, false);
  assert.equal(result.plan.tasks[0].architectureSignificance, 'high');
  const routing = normalizeTaskRoute(result.plan.tasks[0]);
  assert.equal(routing.route, 'standard');
  assert.equal(routing.risk, 'medium');
  assert.equal(routing.architecture, 'high');
  assert.equal(routing.needsArchitect, true);
  assert.equal(routing.peerConvergence, false);
});

test('existing explicit architecture-high task remains authoritative', () => {
  const plan = {
    summary: 'two tasks',
    tasks: [task('local'), task('boundary', { architectureSignificance: 'high' })],
  };
  const result = preserveRequestArchitectureSignificance(
    plan,
    'Refactor the ownership boundary and update its caller.',
  );
  assert.equal(result.changed, false);
  assert.equal(result.requiresCoordinatorCorrection, false);
  assert.equal(result.plan, plan);
});

test('multi-task plan without a preserved architecture owner requires coordinator correction', () => {
  const plan = { summary: 'two tasks', tasks: [task('one'), task('two')] };
  const result = preserveRequestArchitectureSignificance(
    plan,
    'Refactor the ownership boundary and make the unrelated wording update too.',
  );
  assert.equal(result.changed, false);
  assert.equal(result.requiresCoordinatorCorrection, true);
});

test('architecture-heavy read-only plan is not forced into a modifying task', () => {
  const plan = {
    summary: 'inspection only',
    tasks: [task('inspect', {
      title: 'Inspect ownership boundary',
      description: 'Explain the current ownership and interface boundary.',
      route: 'read_only',
      risk: 'low',
      result: 'The requested read-only explanation.',
    })],
  };
  const result = preserveRequestArchitectureSignificance(
    plan,
    'Inspect and explain the ownership boundary between model state and reporting. Do not modify anything.',
  );
  assert.equal(result.requestArchitecture, 'high');
  assert.equal(result.changed, false);
  assert.equal(result.requiresCoordinatorCorrection, false);
  assert.equal(result.plan, plan);
});

test('ordinary request does not acquire architecture significance', () => {
  const plan = { summary: 'one task', tasks: [task('one')] };
  const result = preserveRequestArchitectureSignificance(plan, 'Fix the retry counter behavior and add a regression test.');
  assert.equal(result.changed, false);
  assert.equal(result.requiresCoordinatorCorrection, false);
  assert.equal(result.plan, plan);
});
