'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RecoveryConvergentEngine } = require('../src/orchestrator/recovery-engine');

function fakeUi(overrides = {}) {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return target[property];
      return () => {};
    },
  });
}

function reviewerAgent(revision, reports) {
  const reviewer = {
    name: 'Strong reviewer',
    sink: { value: null },
    model: { id: 'reviewer', name: 'Reviewer' },
    session: {
      async disconnect() {},
      async abort() {},
    },
  };
  reviewer.session.sendAndWait = async () => {
    const next = reports.shift();
    reviewer.sink.value = next.report;
    if (next.revision) revision.value = next.revision;
  };
  return reviewer;
}

const task = {
  id: 'T1',
  title: 'Implement feature',
  description: 'Implement the requested behavior',
  acceptanceCriteria: ['Behavior is correct'],
};

const routing = { route: 'standard', risk: 'medium' };

test('recovery checkpoints include request-lifetime usage state', async () => {
  let persisted;
  const engine = new RecoveryConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => 'R1',
    onCheckpoint: async (state) => { persisted = state; },
  });
  engine.usage.register('1-T1:worker-a', { sessionId: 'a' }, { id: 'worker' }, 'Worker A');
  engine.usage.recordAssistantUsage('1-T1:worker-a', { inputTokens: 80, outputTokens: 8 });
  engine.usage.recordTurn('1-T1:worker-a', 100);

  await engine.saveCheckpoint({
    request: 'do work',
    plan: { tasks: [task] },
    status: 'running',
    nextTaskIndex: 0,
    currentTaskIndex: 0,
    stage: 'task_started',
  });

  assert.equal(persisted.usage.version, 1);
  assert.equal(persisted.usage.agents[0].inputTokens, 80);
  assert.equal(persisted.usage.agents[0].outputTokens, 8);
});

test('reviewer workspace mutation is invalidated, revalidated, then reviewed in a later cycle', async () => {
  const revision = { value: 'R1' };
  const reviewer = reviewerAgent(revision, [
    { revision: 'R2', report: { verdict: 'clean', summary: 'formatted while reviewing', findings: [], checks: [] } },
    { revision: 'R2', report: { verdict: 'clean', summary: 'clean after worker revalidation', findings: [], checks: [] } },
  ]);
  const events = [];

  class TestEngine extends RecoveryConvergentEngine {
    async captureIntegrityState() {
      return {
        head: 'H',
        entries: [{ path: 'src/lib.rs', status: ' M', fingerprint: revision.value }],
      };
    }
    async consultReviewerMutationCoordinator(_task, incident) {
      events.push(`adjudicate:R${incident.reviewCycle}`);
      return { action: 'retry', rationale: 'Formatter side effect is attributable.', guidance: 'Verify the resulting diff.' };
    }
    async revalidateReviewerMutation(_task, _a, _b, _routing, incident) {
      events.push(`revalidate:R${incident.reviewCycle}`);
      return { revision: revision.value, evidence: [{ agent: 'Worker A', check: 'independent validation passed' }] };
    }
  }

  const engine = new TestEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi({
      reviewResult(_review, cycle) { events.push(`accepted:R${cycle}`); },
    }),
    revisionProvider: async () => revision.value,
    maxReviewerCycles: 3,
    onCheckpoint: async () => {},
  });

  await engine.runStrongReview(task, { name: 'A', session: {} }, null, reviewer, [], routing);

  assert.deepEqual(events, ['adjudicate:R1', 'revalidate:R1', 'accepted:R2']);
  assert.equal(engine.activeReviewDossier.cycles.length, 2);
  assert.equal(engine.activeReviewDossier.cycles[0].cycle, 1);
  assert.ok(engine.activeReviewDossier.cycles[0].integrityIncident);
  assert.equal(engine.activeReviewDossier.cycles[1].verdict, 'clean');
});