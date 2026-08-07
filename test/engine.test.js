'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ConvergentEngine } = require('../src/orchestrator/engine');

function fakeUi() {
  return new Proxy({}, { get: () => () => {} });
}

function fakeWorker(name, scriptedReports, revisionState) {
  const sink = { value: null };
  return {
    name,
    sink,
    session: {
      async sendAndWait() {
        const next = scriptedReports.shift();
        if (!next) throw new Error(`No scripted report left for worker ${name}`);
        if (next.nextRevision) revisionState.value = next.nextRevision;
        sink.value = next.report;
      },
    },
  };
}

const task = {
  id: 't1',
  title: 'Test task',
  description: 'Implement something',
  acceptanceCriteria: ['It works'],
};

test('convergence requires A and B clean on same revision', async () => {
  const revision = { value: 'R1' };
  const engine = new ConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => revision.value,
    maxWorkerPasses: 5,
  });
  const a = fakeWorker('A', [
    { report: { verdict: 'clean', summary: 'A clean', findings: [], checks: [] } },
  ], revision);
  const b = fakeWorker('B', [
    { report: { verdict: 'clean', summary: 'B clean', findings: [], checks: [] } },
  ], revision);

  const previous = { worker: 'A', changed: false, revision: 'R1', report: { verdict: 'clean' } };
  const result = await engine.convergeWorkers(task, a, b, b, previous);
  assert.equal(result, 'R1');
});

test('a change invalidates earlier clean approval', async () => {
  const revision = { value: 'R1' };
  const engine = new ConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => revision.value,
    maxWorkerPasses: 5,
  });
  const a = fakeWorker('A', [
    { report: { verdict: 'clean', summary: 'A approves R2', findings: [], checks: [] } },
  ], revision);
  const b = fakeWorker('B', [
    { nextRevision: 'R2', report: { verdict: 'changed', summary: 'B fixed issue', findings: ['x'], checks: [] } },
    { report: { verdict: 'clean', summary: 'B approves R2', findings: [], checks: [] } },
  ], revision);

  const previous = { worker: 'A', changed: false, revision: 'R1', report: { verdict: 'clean' } };
  const result = await engine.convergeWorkers(task, a, b, b, previous);
  assert.equal(result, 'R2');
});

test('worker cannot claim clean while changing revision', async () => {
  const revision = { value: 'R1' };
  const engine = new ConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => revision.value,
  });
  const a = fakeWorker('A', [
    { nextRevision: 'R2', report: { verdict: 'clean', summary: 'incorrect', findings: [], checks: [] } },
  ], revision);
  await assert.rejects(() => engine.runWorkerPass(a, task, 'REVIEW_AND_FIX', null), /reported CLEAN but changed/);
});
