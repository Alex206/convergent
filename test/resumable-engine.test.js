'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResumableConvergentEngine } = require('../src/orchestrator/resumable-engine');
const pkg = require('../package.json');

function fakeUi(overrides = {}) {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return target[property];
      return () => {};
    },
  });
}

function sessionAgent(name) {
  return {
    name,
    sink: { value: null },
    model: { id: name.toLowerCase().replaceAll(' ', '-'), name },
    reasoningEffort: 'medium',
    session: {
      async disconnect() {},
      async abort() {},
    },
  };
}

const task = {
  id: 'T5',
  title: 'Complex implementation',
  description: 'Implement the requested behavior',
  acceptanceCriteria: ['Behavior is correct'],
};

const routing = { route: 'high_risk', risk: 'high' };

test('package defaults make review cycles a soft three-cycle decision tranche', () => {
  const setting = pkg.contributes.configuration.properties['convergent.maxReviewerCycles'];
  assert.equal(setting.default, 3);
  assert.equal(setting.maximum, 20);
  assert.match(setting.description, /soft/i);
  assert.match(setting.description, /asking/i);
});

test('strong review asks at cycle limit and continues when user extends it', async () => {
  const revision = { value: 'R1' };
  const checkpoints = [];
  const decisions = [];
  const reports = [
    { verdict: 'findings', summary: 'first', findings: [{ severity: 'high', title: 'F1', description: 'one' }] },
    { verdict: 'findings', summary: 'second', findings: [{ severity: 'high', title: 'F2', description: 'two' }] },
    { verdict: 'findings', summary: 'third', findings: [{ severity: 'high', title: 'F3', description: 'three' }] },
    { verdict: 'clean', summary: 'clean', findings: [] },
  ];
  const reviewer = sessionAgent('Strong reviewer');
  reviewer.session.sendAndWait = async () => {
    reviewer.sink.value = reports.shift();
  };

  const engine = new ResumableConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {},
    ui: fakeUi({
      async limitDecision(kind, detail) {
        decisions.push({ kind, detail });
        return { action: 'continue', additional: 1 };
      },
    }),
    revisionProvider: async () => revision.value,
    maxReviewerCycles: 3,
    onCheckpoint: async (state) => checkpoints.push(state),
  });
  engine.activeTaskCheckpointContext = { request: 'do work', plan: { tasks: [task] }, index: 0 };
  engine.finishTurn = async () => ({});
  engine.runWorkerPass = async (worker) => ({
    worker: worker.name,
    report: { verdict: 'changed', summary: 'fixed', findings: [], checks: [] },
    changed: true,
    revision: revision.value = `${revision.value}x`,
  });
  engine.convergeFromPass = async (_task, _a, _b, pass) => ({ revision: pass.revision, evidence: [] });

  await engine.runStrongReview(task, sessionAgent('A'), sessionAgent('B'), reviewer, [], routing);

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, 'reviewer_cycles');
  assert.equal(decisions[0].detail.current, 3);
  assert.ok(checkpoints.some((state) => state.taskState?.stage === 'strong_review_findings'));
});

test('strong review pauses cleanly at the soft limit when user chooses pause', async () => {
  const reviewer = sessionAgent('Strong reviewer');
  reviewer.session.sendAndWait = async () => {
    reviewer.sink.value = { verdict: 'findings', summary: 'still broken', findings: [{ severity: 'high', title: 'F1', description: 'one' }] };
  };
  const engine = new ResumableConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {},
    ui: fakeUi({ async limitDecision() { return { action: 'pause' }; } }),
    revisionProvider: async () => 'R1',
    maxReviewerCycles: 1,
    onCheckpoint: async () => {},
  });
  engine.activeTaskCheckpointContext = { request: 'do work', plan: { tasks: [task] }, index: 0 };
  engine.finishTurn = async () => ({});

  await assert.rejects(
    () => engine.runStrongReview(task, sessionAgent('A'), sessionAgent('B'), reviewer, [], routing),
    (error) => error?.code === 'CONVERGENT_PAUSED',
  );
});

test('AI-credit soft budget extends from current reported usage', async () => {
  const engine = new ResumableConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {},
    ui: fakeUi({ async limitDecision() { return { action: 'continue', additional: 50 }; } }),
    revisionProvider: async () => 'R1',
    maxAiCredits: 100,
  });
  engine.getUsageSummary = () => ({ aiCredits: 125, hasCreditData: true });

  await engine.checkAiCreditBudget('test');
  assert.equal(engine.aiCreditCeiling, 175);
});

test('resume from strong-review findings starts with remediation rather than implementation', async () => {
  const calls = [];
  class TestEngine extends ResumableConvergentEngine {
    async runWorkerPass(worker, _task, mode) {
      calls.push(`${worker.name}:${mode}`);
      return { worker: worker.name, report: { verdict: 'changed', summary: 'fixed', findings: [], checks: [] }, changed: true, revision: 'R2' };
    }
    async convergeFromPass() { return { revision: 'R2', evidence: [] }; }
    async runStrongReview() { calls.push('review'); }
    async disposeTaskSessions() {}
  }
  const factory = {
    async createWorker(_key, name) { return sessionAgent(name); },
    async createReviewer() { return sessionAgent('Strong reviewer'); },
  };
  const engine = new TestEngine({ client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(), revisionProvider: async () => 'R2' });
  engine.activeTaskCheckpointContext = { request: 'do work', plan: { tasks: [task] }, index: 0 };
  await engine.runFullTask(factory, task, '1-T5', routing, {
    stage: 'strong_review_findings',
    reviewCycle: 2,
    findings: [{ severity: 'high', title: 'F1', description: 'one' }],
  });
  assert.deepEqual(calls, ['A:FIX_STRONG_REVIEW_FINDINGS', 'review']);
});

test('blocked worker can hand the preserved revision to its peer instead of failing convergence', async () => {
  const calls = [];
  class TestEngine extends ResumableConvergentEngine {
    async requestWorkerBlockedDecision() { return { action: 'peer' }; }
    async runWorkerPass(worker) {
      calls.push(worker.name);
      return { worker: worker.name, report: { verdict: 'clean', summary: 'ok', findings: [], checks: [] }, changed: false, revision: 'R1' };
    }
  }
  const engine = new TestEngine({ client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(), revisionProvider: async () => 'R1' });
  const a = sessionAgent('A');
  const b = sessionAgent('B');
  const result = await engine.convergeFromPass(task, a, b, {
    worker: 'A', report: { verdict: 'blocked', summary: 'environment unavailable', findings: [], checks: [] }, changed: true, revision: 'R1',
  }, routing);
  assert.deepEqual(calls, ['B']);
  assert.equal(result.revision, 'R1');
});

test('blocked worker can pause with its blocker and revision checkpointed', async () => {
  const checkpoints = [];
  const engine = new ResumableConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {},
    ui: fakeUi(), revisionProvider: async () => 'R1',
    userInputHandler: async () => ({ answer: 'Pause & resume later' }),
    onCheckpoint: async (state) => checkpoints.push(state),
  });
  engine.activeTaskCheckpointContext = { request: 'do work', plan: { tasks: [task] }, index: 0 };
  await assert.rejects(
    () => engine.requestWorkerBlockedDecision(task, sessionAgent('A'), sessionAgent('B'), {
      worker: 'A', report: { verdict: 'blocked', summary: 'compiler missing', findings: [], checks: [] }, changed: true, revision: 'R1',
    }, routing),
    (error) => error?.code === 'CONVERGENT_PAUSED',
  );
  assert.equal(checkpoints.at(-1).taskState.stage, 'worker_blocked');
  assert.equal(checkpoints.at(-1).taskState.blockedPass.revision, 'R1');
});

test('blocked strong reviewer can retry the same review cycle instead of failing the task', async () => {
  const reports = [
    { verdict: 'blocked', summary: 'tool missing', findings: [] },
    { verdict: 'clean', summary: 'resolved', findings: [] },
  ];
  const reviewer = sessionAgent('Strong reviewer');
  reviewer.session.sendAndWait = async () => { reviewer.sink.value = reports.shift(); };
  class TestEngine extends ResumableConvergentEngine {
    async requestReviewerBlockedDecision() { return { action: 'retry' }; }
  }
  const engine = new TestEngine({ client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(), revisionProvider: async () => 'R1' });
  engine.finishTurn = async () => ({});
  await engine.runStrongReview(task, sessionAgent('A'), sessionAgent('B'), reviewer, [], routing);
  assert.equal(reports.length, 0);
});