'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ConvergentEngine,
  requireReport,
  formatPeerPass,
  evidenceFromPass,
  mergeEvidence,
  formatValidationEvidence,
  passApprovesRevision,
} = require('../src/orchestrator/engine');

function fakeUi() {
  return new Proxy({}, { get: () => () => {} });
}

function fakeWorker(name, scriptedReports, revisionState) {
  const sink = { value: null };
  return {
    name,
    sink,
    model: { id: `model-${name}`, name: `Model ${name}` },
    session: {
      async sendAndWait() {
        const next = scriptedReports.shift();
        if (!next) throw new Error(`No scripted report left for worker ${name}`);
        if (next.nextRevision) revisionState.value = next.nextRevision;
        sink.value = next.report;
      },
      async disconnect() {},
    },
  };
}

function fakeReviewer(scriptedReports) {
  const sink = { value: null };
  return {
    name: 'Strong reviewer',
    sink,
    model: { id: 'reviewer', name: 'Reviewer' },
    session: {
      async sendAndWait() {
        const next = scriptedReports.shift();
        if (!next) throw new Error('No scripted reviewer report left');
        sink.value = next;
      },
      async disconnect() {},
    },
  };
}

const task = {
  id: 't1',
  title: 'Test task',
  description: 'Implement something',
  acceptanceCriteria: ['It works'],
};

test('clean and changed passes both approve their exact resulting revision', () => {
  assert.equal(passApprovesRevision({ report: { verdict: 'clean' } }), true);
  assert.equal(passApprovesRevision({ report: { verdict: 'changed' } }), true);
  assert.equal(passApprovesRevision({ report: { verdict: 'blocked' } }), false);
});

test('initial changed implementation plus clean peer approval converges without self-review', async () => {
  const revision = { value: 'R2' };
  const engine = new ConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => revision.value,
    maxWorkerPasses: 5,
  });
  const a = fakeWorker('A', [], revision);
  const b = fakeWorker('B', [
    { report: { verdict: 'clean', summary: 'B clean', findings: [], checks: ['B check passed'] } },
  ], revision);

  const previous = {
    worker: 'A',
    changed: true,
    revision: 'R2',
    report: { verdict: 'changed', summary: 'A implemented R2', findings: [], checks: ['A test passed'] },
  };
  const result = await engine.convergeWorkers(task, a, b, b, previous);
  assert.equal(result.revision, 'R2');
  assert.deepEqual(result.evidence, [
    { agent: 'Worker A', check: 'A test passed' },
    { agent: 'Worker B', check: 'B check passed' },
  ]);
});

test('a peer change invalidates earlier approval and evidence but approves the new revision', async () => {
  const revision = { value: 'R1' };
  const engine = new ConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => revision.value,
    maxWorkerPasses: 5,
  });
  const a = fakeWorker('A', [
    { report: { verdict: 'clean', summary: 'A approves R2', findings: [], checks: ['A checked R2'] } },
  ], revision);
  const b = fakeWorker('B', [
    { nextRevision: 'R2', report: { verdict: 'changed', summary: 'B fixed issue', findings: [], checks: ['B tests on R2 passed'] } },
  ], revision);

  const previous = {
    worker: 'A',
    changed: false,
    revision: 'R1',
    report: { verdict: 'clean', checks: ['old R1 check'] },
  };
  const result = await engine.convergeWorkers(task, a, b, b, previous);
  assert.equal(result.revision, 'R2');
  assert.deepEqual(result.evidence, [
    { agent: 'Worker B', check: 'B tests on R2 passed' },
    { agent: 'Worker A', check: 'A checked R2' },
  ]);
  assert.equal(result.evidence.some((item) => item.check === 'old R1 check'), false);
});

test('validation evidence helpers deduplicate checks and format reviewer context', () => {
  const pass = {
    worker: 'A',
    revision: 'R2',
    report: { checks: ['python -B -m unittest: passed', 'python -B -m unittest: passed'] },
  };
  const initial = evidenceFromPass(pass);
  const merged = mergeEvidence([], pass, 'R2');
  assert.equal(initial.length, 2);
  assert.equal(merged.length, 1);
  const text = formatValidationEvidence(merged);
  assert.match(text, /Worker A: python -B -m unittest: passed/);
  assert.match(text, /evidence, not proof/i);
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

test('structured report survives a late session idle timeout', async () => {
  const sink = { value: null };
  let aborted = false;
  const session = {
    async sendAndWait() {
      sink.value = { verdict: 'clean', summary: 'done', findings: [], checks: [] };
      throw new Error('Timeout after 60000ms waiting for session.idle');
    },
    async abort() {
      aborted = true;
    },
  };

  const report = await requireReport(session, sink, 'review', 'report_pass', 1234);
  assert.equal(report.verdict, 'clean');
  assert.equal(aborted, true);
});

test('peer pass context carries the opposing worker technical position and validation', () => {
  const text = formatPeerPass({
    worker: 'B',
    changed: true,
    revision: 'R2',
    report: {
      verdict: 'changed',
      summary: 'Changed locking strategy after finding a shutdown race.',
      findings: [],
      checks: ['unit tests passed'],
    },
  });

  assert.match(text, /Previous peer pass from Worker B/);
  assert.match(text, /Changed locking strategy/);
  assert.match(text, /unit tests passed/);
  assert.match(text, /Challenge it where warranted/);
});

test('trivial route finishes after one clean peer review', async () => {
  const revision = { value: 'R1' };
  const a = fakeWorker('A', [
    { nextRevision: 'R2', report: { verdict: 'changed', summary: 'implemented', findings: [], checks: [] } },
  ], revision);
  const b = fakeWorker('B', [
    { report: { verdict: 'clean', summary: 'approved', findings: [], checks: [] } },
  ], revision);
  const factory = {
    async createWorker(_taskId, name) { return name === 'A' ? a : b; },
    async createReviewer() { throw new Error('reviewer must not be created for clean trivial route'); },
  };
  const engine = new ConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => revision.value,
  });

  const outcome = await engine.runTrivialTask(factory, task, 't1');
  assert.deepEqual(outcome, { route: 'trivial', escalated: false });
});

test('trivial escalation converges after A approves the revision changed by B', async () => {
  const revision = { value: 'R1' };
  const a = fakeWorker('A', [
    { nextRevision: 'R2', report: { verdict: 'changed', summary: 'implemented', findings: [], checks: ['A test R2'] } },
    { report: { verdict: 'clean', summary: 'A approves B fix', findings: [], checks: ['A check R3'] } },
  ], revision);
  const b = fakeWorker('B', [
    { nextRevision: 'R3', report: { verdict: 'changed', summary: 'B fixed issue', findings: [], checks: ['B test R3'] } },
  ], revision);
  const reviewer = fakeReviewer([
    { verdict: 'clean', summary: 'strong review clean', findings: [], checks: [] },
  ]);
  const factory = {
    async createWorker(_taskId, name) { return name === 'A' ? a : b; },
    async createReviewer() { return reviewer; },
  };
  const engine = new ConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => revision.value,
    maxWorkerPasses: 5,
  });

  const outcome = await engine.runTrivialTask(factory, task, 't1', { risk: 'low' });
  assert.deepEqual(outcome, { route: 'standard', escalated: true });
  assert.equal(revision.value, 'R3');
});
