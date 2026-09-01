'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { replayProjectEvents } = require('../src/project/state-machine');
const { planProjectRecovery } = require('../src/project/recovery');

function event(id, type, data = {}) {
  return { id, type, data };
}

function executingState() {
  return replayProjectEvents([
    event('e1', 'PROJECT_CREATED', { projectId: 'P1', objective: 'Recover safely', budgetTotal: 20 }),
    event('e2', 'DISCOVERY_STARTED'),
    event('e3', 'PLAN_PROPOSED', {
      planRevision: 1,
      milestones: [{ id: 'M1', objective: 'Ship slice', acceptanceCriteria: ['validated'], budgetAllocation: 10 }],
    }),
    event('e4', 'PLAN_APPROVED', { planRevision: 1 }),
    event('e5', 'MILESTONE_STARTED', { id: 'M1' }),
  ]);
}

test('recovery refuses replacement execution while a previous executor may still be active', () => {
  const plan = planProjectRecovery(executingState(), {
    executor: 'may-be-running',
    workspace: 'matches',
    external: 'reconciled',
  });
  assert.equal(plan.safeToStartExecution, false);
  assert.deepEqual(plan.actions.map((action) => action.kind), ['prove_previous_executor_stopped']);
  assert.equal(plan.continuation, 'continue_active_milestone');
});

test('recovery requires workspace and external reconciliation independently of model handoff', () => {
  const plan = planProjectRecovery(executingState(), {
    executor: 'known-stopped',
    workspace: 'drifted',
    external: 'unknown',
  });
  assert.equal(plan.safeToStartExecution, false);
  assert.deepEqual(plan.actions.map((action) => action.kind), ['reconcile_workspace', 'reconcile_external_state']);
  assert.equal(plan.handoff.project.id, 'P1');
});

test('recovery allows execution only after deterministic boundaries are reconciled', () => {
  const plan = planProjectRecovery(executingState(), {
    executor: 'known-stopped',
    workspace: 'matches',
    external: 'reconciled',
  });
  assert.equal(plan.safeToStartExecution, true);
  assert.deepEqual(plan.actions, []);
});

test('stakeholder gates remain non-executable even when infrastructure is reconciled', () => {
  const state = replayProjectEvents([
    event('e1', 'PROJECT_CREATED', { projectId: 'P1', objective: 'Ask when material' }),
    event('e2', 'DISCOVERY_STARTED'),
    event('e3', 'QUESTION_RAISED', { id: 'Q1', text: 'Choose compatibility policy.' }),
  ]);
  const plan = planProjectRecovery(state, {
    executor: 'none', workspace: 'matches', external: 'reconciled',
  });
  assert.equal(plan.safeToStartExecution, false);
  assert.equal(plan.continuation, 'wait_for_stakeholder_answer');
});