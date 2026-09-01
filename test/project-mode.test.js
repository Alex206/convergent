'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROJECT_STATUSES } = require('../src/project/model');
const { applyProjectEvent, replayProjectEvents } = require('../src/project/state-machine');
const { buildProjectManagerHandoff } = require('../src/project/handoff');

function event(id, type, data = {}) {
  return { id, type, at: `2026-08-26T09:${String(Number(id.replace(/\D/g, '') || 0) % 60).padStart(2, '0')}:00Z`, data };
}

function created(id = 'e1') {
  return event(id, 'PROJECT_CREATED', {
    projectId: 'P1',
    objective: 'Deliver the requested product through accepted milestones.',
    stakeholders: ['product-owner'],
    budgetTotal: 100,
    executionTarget: {
      kind: 'garm-portainer',
      isolation: 'project',
      runnerLabels: ['linux', 'project-mode'],
      pool: 'engineering',
      portainerEndpointId: 'prod-02',
      image: 'internal/convergent-project:dev',
      capabilities: ['git', 'container', 'preview'],
    },
  });
}

function proposedPlan(id = 'e6') {
  return event(id, 'PLAN_PROPOSED', {
    planRevision: 1,
    milestones: [
      {
        id: 'M1',
        objective: 'Produce the first reviewable product slice.',
        deliverables: ['working slice'],
        acceptanceCriteria: ['slice is validated'],
        budgetAllocation: 40,
      },
      {
        id: 'M2',
        objective: 'Complete the remaining approved scope.',
        deliverables: ['complete product'],
        dependencies: ['M1'],
        acceptanceCriteria: ['project acceptance checks pass'],
        budgetAllocation: 50,
      },
    ],
  });
}

test('project replay reaches accepted completion with deterministic budget and GARM/Portainer target', () => {
  const events = [
    created('e1'),
    event('e2', 'DISCOVERY_STARTED'),
    event('e3', 'USE_CASE_ADDED', {
      id: 'UC1', title: 'Primary workflow', description: 'Stakeholder uses the delivered workflow.', actors: ['user'], acceptanceCriteria: ['workflow succeeds'],
    }),
    event('e4', 'REQUIREMENT_ADDED', {
      id: 'R1', text: 'The product must support the primary workflow.', acceptanceCriteria: ['UC1 passes'], priority: 'must',
    }),
    event('e5', 'QUESTION_RAISED', { id: 'Q1', text: 'Which compatibility boundary is required?', reason: 'Changes the public contract.' }),
    event('e6', 'QUESTION_ANSWERED', { id: 'Q1', answer: 'Keep backward compatibility.' }),
    proposedPlan('e7'),
    event('e8', 'PLAN_APPROVED', { planRevision: 1 }),
    event('e9', 'MILESTONE_STARTED', { id: 'M1' }),
    event('e10', 'BUDGET_RESERVED', { amount: 40, scopeId: 'M1' }),
    event('e11', 'BUDGET_SPENT', { amount: 15, reservedAmount: 15, scopeId: 'M1' }),
    event('e12', 'MILESTONE_READY_FOR_REVIEW', { id: 'M1' }),
    event('e13', 'MILESTONE_ACCEPTED', { id: 'M1' }),
    event('e14', 'MILESTONE_STARTED', { id: 'M2' }),
    event('e15', 'MILESTONE_READY_FOR_REVIEW', { id: 'M2' }),
    event('e16', 'MILESTONE_ACCEPTED', { id: 'M2' }),
    event('e17', 'PROJECT_COMPLETED'),
  ];

  const state = replayProjectEvents(events);
  assert.equal(state.status, PROJECT_STATUSES.COMPLETED);
  assert.equal(state.revision, 17);
  assert.equal(state.requirements[0].revision, 1);
  assert.equal(state.openQuestions[0].status, 'answered');
  assert.equal(state.milestones[0].status, 'accepted');
  assert.equal(state.milestones[1].status, 'accepted');
  assert.deepEqual(state.budget, {
    unit: 'ai_credits',
    total: 100,
    spent: 15,
    reserved: 25,
    remaining: 85,
    available: 60,
    ledger: [
      { eventId: 'e10', type: 'BUDGET_RESERVED', amount: 40, at: events[9].at, scopeId: 'M1' },
      { eventId: 'e11', type: 'BUDGET_SPENT', amount: 15, at: events[10].at, scopeId: 'M1', reservedAmount: 15 },
    ],
  });
  assert.equal(state.executionTarget.kind, 'garm-portainer');
  assert.deepEqual(state.executionTarget.runnerLabels, ['linux', 'project-mode']);

  const handoff = buildProjectManagerHandoff(state);
  assert.equal(handoff.project.revision, 17);
  assert.equal(handoff.continuation.nextAction, 'none');
  assert.deepEqual(handoff.openQuestions, []);
  assert.equal(handoff.executionTarget.kind, 'garm-portainer');
  assert.match(handoff.handoffId, /^[a-f0-9]{64}$/);
});

test('project manager handoff is stable across fresh sessions and does not depend on model transcript state', () => {
  const state = replayProjectEvents([
    created('e1'),
    event('e2', 'DISCOVERY_STARTED'),
    event('e3', 'REQUIREMENT_ADDED', { id: 'R1', text: 'Persist project knowledge outside model sessions.' }),
    proposedPlan('e4'),
  ]);

  const first = buildProjectManagerHandoff(state);
  const second = buildProjectManagerHandoff(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(second, first);
  assert.equal(first.project.status, PROJECT_STATUSES.AWAITING_PLAN_APPROVAL);
  assert.equal(first.continuation.nextAction, 'wait_for_plan_approval');
  assert.equal(Object.hasOwn(first, 'appliedEventFingerprints'), false);
});

test('duplicate delivery of the same durable event is idempotent but event-id reuse with different content fails closed', () => {
  let state = replayProjectEvents([
    created('e1'),
    event('e2', 'DISCOVERY_STARTED'),
  ]);
  const requirement = event('e3', 'REQUIREMENT_ADDED', { id: 'R1', text: 'One authoritative requirement.' });
  state = applyProjectEvent(state, requirement);
  const revision = state.revision;
  state = applyProjectEvent(state, { ...requirement, data: { text: 'One authoritative requirement.', id: 'R1' } });
  assert.equal(state.revision, revision);
  assert.equal(state.requirements.length, 1);
  assert.throws(
    () => applyProjectEvent(state, event('e3', 'REQUIREMENT_ADDED', { id: 'R1', text: 'Conflicting payload.' })),
    /reused with different content/i,
  );
});

test('state machine rejects execution before plan approval and dependency violations', () => {
  let state = replayProjectEvents([created('e1'), event('e2', 'DISCOVERY_STARTED'), proposedPlan('e3')]);
  assert.throws(() => applyProjectEvent(state, event('e4', 'MILESTONE_STARTED', { id: 'M1' })), /not valid/i);
  state = applyProjectEvent(state, event('e4', 'PLAN_APPROVED', { planRevision: 1 }));
  assert.throws(() => applyProjectEvent(state, event('e5', 'MILESTONE_STARTED', { id: 'M2' })), /dependency 'M1'/i);
});

test('project budget cannot over-reserve, over-release, or silently exceed the approved ceiling', () => {
  let state = replayProjectEvents([created('e1')]);
  state = applyProjectEvent(state, event('e2', 'BUDGET_RESERVED', { amount: 80, scopeId: 'M1' }));
  assert.equal(state.budget.available, 20);
  assert.throws(() => applyProjectEvent(state, event('e3', 'BUDGET_RESERVED', { amount: 21 })), /only 20/i);
  assert.throws(() => applyProjectEvent(state, event('e4', 'BUDGET_RELEASED', { amount: 81 })), /only 80/i);
  state = applyProjectEvent(state, event('e5', 'BUDGET_SPENT', { amount: 30, reservedAmount: 30, scopeId: 'M1' }));
  assert.equal(state.budget.spent, 30);
  assert.equal(state.budget.reserved, 50);
  assert.equal(state.budget.available, 20);
  assert.throws(() => applyProjectEvent(state, event('e6', 'BUDGET_SPENT', { amount: 25 })), /exceeds available/i);
});

test('stakeholder questions and pause/resume preserve the exact semantic continuation boundary', () => {
  let state = replayProjectEvents([created('e1'), event('e2', 'DISCOVERY_STARTED')]);
  state = applyProjectEvent(state, event('e3', 'QUESTION_RAISED', { id: 'Q1', text: 'Choose API compatibility policy.' }));
  assert.equal(state.status, PROJECT_STATUSES.AWAITING_STAKEHOLDER);
  assert.equal(buildProjectManagerHandoff(state).continuation.nextAction, 'wait_for_stakeholder_answer');

  state = applyProjectEvent(state, event('e4', 'PROJECT_PAUSED'));
  assert.equal(state.status, PROJECT_STATUSES.PAUSED);
  state = applyProjectEvent(state, event('e5', 'PROJECT_RESUMED'));
  assert.equal(state.status, PROJECT_STATUSES.AWAITING_STAKEHOLDER);
  state = applyProjectEvent(state, event('e6', 'QUESTION_ANSWERED', { id: 'Q1', answer: 'Maintain compatibility.' }));
  assert.equal(state.status, PROJECT_STATUSES.DISCOVERY);
});

test('execution target is restricted to local or company GARM/Portainer backends and cannot switch mid-milestone', () => {
  assert.throws(
    () => replayProjectEvents([event('e1', 'PROJECT_CREATED', { projectId: 'P1', objective: 'x', executionTarget: { kind: 'external-cloud' } })]),
    /unsupported execution target/i,
  );

  let state = replayProjectEvents([created('e1'), event('e2', 'DISCOVERY_STARTED'), proposedPlan('e3'), event('e4', 'PLAN_APPROVED', { planRevision: 1 }), event('e5', 'MILESTONE_STARTED', { id: 'M1' })]);
  assert.throws(
    () => applyProjectEvent(state, event('e6', 'EXECUTION_TARGET_SELECTED', { target: { kind: 'local', workspaceRef: '/repo' } })),
    /while a milestone is active/i,
  );
});