'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ConvergentEngine } = require('../src/orchestrator/engine');
const { ResumableConvergentEngine } = require('../src/orchestrator/resumable-engine');

function ui(events = []) {
  return new Proxy({
    phase(title, detail) { events.push({ type: 'phase', title, detail }); },
    log(message) { events.push({ type: 'log', message }); },
    audit(event) { events.push(event); },
  }, {
    get(target, property) {
      if (property in target) return target[property];
      return () => {};
    },
  });
}

function engineOptions(events = []) {
  return {
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: ui(events),
    revisionProvider: async () => 'R1',
  };
}

test('base engine skips coordinator creation for a cohesive modifying request', async () => {
  const events = [];
  const engine = new ConvergentEngine(engineOptions(events));
  const factory = {
    async createCoordinator() { throw new Error('coordinator must not be created'); },
  };
  const prepared = await engine.preparePlan(factory, 'Implement retry backoff in the existing client and add focused tests.');
  assert.equal(prepared.planningMode, 'deterministic');
  assert.equal(prepared.coordinator, null);
  assert.equal(prepared.plan.tasks.length, 1);
  assert.equal(prepared.plan.tasks[0].route, 'standard');
  assert.ok(events.some((event) => event.type === 'deterministic_plan_formed'));
});

test('resumable engine inherits the same deterministic planning boundary', async () => {
  const engine = new ResumableConvergentEngine({ ...engineOptions(), onCheckpoint: async () => {} });
  const prepared = await engine.preparePlan({
    async createCoordinator() { throw new Error('coordinator must not be created'); },
  }, 'Fix authentication token validation and add focused tests.');
  assert.equal(prepared.planningMode, 'deterministic');
  assert.equal(prepared.plan.tasks[0].route, 'high_risk');
  assert.equal(prepared.plan.tasks[0].risk, 'high');
});

test('read-only request still invokes the strong coordinator planning path', async () => {
  const events = [];
  const engine = new ConvergentEngine(engineOptions(events));
  engine.finishTurn = async () => ({ totalAiCredits: 1 });
  const sink = { value: null };
  let created = 0;
  const coordinator = {
    name: 'Coordinator', usageName: 'coordinator', sink,
    model: { id: 'strong', name: 'Strong' }, reasoningEffort: 'medium',
    session: {
      async sendAndWait() {
        sink.value = {
          summary: 'Read-only inspection',
          tasks: [{
            id: 'inspect', title: 'Inspect retry behavior', description: 'Explain current retry behavior.',
            acceptanceCriteria: ['Answer the request'], route: 'read_only', risk: 'low',
            architectureSignificance: 'low', routingReason: 'read-only inspection', inspectionHints: [], result: 'Current behavior explained.',
          }],
        };
      },
    },
  };
  const prepared = await engine.preparePlan({
    async createCoordinator() { created += 1; return coordinator; },
  }, 'Explain how retry backoff currently works.');
  assert.equal(created, 1);
  assert.equal(prepared.planningMode, 'coordinator');
  assert.equal(prepared.coordinator, coordinator);
  assert.equal(prepared.plan.tasks[0].route, 'read_only');
});

test('architecturally significant request still invokes coordinator before the architect specialist', async () => {
  const engine = new ConvergentEngine(engineOptions());
  engine.finishTurn = async () => ({});
  const sink = { value: null };
  let created = 0;
  const coordinator = {
    name: 'Coordinator', usageName: 'coordinator', sink,
    model: { id: 'strong', name: 'Strong' }, reasoningEffort: 'medium',
    session: {
      async sendAndWait() {
        sink.value = {
          summary: 'Architectural task',
          tasks: [{
            id: 'runtime', title: 'Add runtime provider boundary', description: 'Introduce a runtime abstraction and backend provider boundary.',
            acceptanceCriteria: ['Preserve behavior'], route: 'standard', risk: 'medium', architectureSignificance: 'high',
            routingReason: 'cross-cutting ownership boundary', inspectionHints: [], result: '',
          }],
        };
      },
    },
  };
  const prepared = await engine.preparePlan({ async createCoordinator() { created += 1; return coordinator; } }, 'Introduce a runtime abstraction and backend provider boundary while preserving current behavior.');
  assert.equal(created, 1);
  assert.equal(prepared.planningMode, 'coordinator');
});
