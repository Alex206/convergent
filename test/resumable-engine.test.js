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
  assert.match(setting.description, /asks/i);
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
  engine.runWorkerPass = async () => ({
    worker: 'A',
    report: { verdict: 'changed', summary: 'fixed', findings: [], checks: [] },
    changed: true,
    revision: revision.value,
  });
  engine.convergeWorkers = async () => ({ revision: revision.value, evidence: [] });

  await engine.runStrongReview(task, sessionAgent('A'), sessionAgent('B'), reviewer, [], routing);

  assert.equal(reports.length, 0);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, 'reviewer_cycles');
  assert.equal(decisions[0].detail.current, 3);
  const findingCycles = checkpoints
    .filter((state) => state.taskState?.stage === 'strong_review_findings')
    .map((state) => state.taskState.reviewCycle);
  assert.deepEqual(findingCycles, [1, 2, 3]);
  assert.ok(checkpoints.some((state) => state.taskState?.stage === 'strong_review_pending' && state.taskState.nextReviewCycle === 4));
});

test('strong review pauses cleanly at the soft limit when user chooses pause', async () => {
  const reviewer = sessionAgent('Strong reviewer');
  reviewer.session.sendAndWait = async () => {
    reviewer.sink.value = {
      verdict: 'findings',
      summary: 'still one issue',
      findings: [{ severity: 'high', title: 'F1', description: 'one' }],
    };
  };
  const engine = new ResumableConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {},
    ui: fakeUi({ async limitDecision() { return { action: 'pause' }; } }),
    revisionProvider: async () => 'R1',
    maxReviewerCycles: 1,
  });
  engine.activeTaskCheckpointContext = { request: 'do work', plan: { tasks: [task] }, index: 0 };
  engine.finishTurn = async () => ({});

  await assert.rejects(
    engine.runStrongReview(task, sessionAgent('A'), sessionAgent('B'), reviewer, [], routing),
    (error) => error?.code === 'CONVERGENT_PAUSED',
  );
});

test('AI-credit soft budget extends from current reported usage', async () => {
  const decisions = [];
  const engine = new ResumableConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {},
    ui: fakeUi({
      async limitDecision(kind, detail) {
        decisions.push({ kind, detail });
        return { action: 'continue', additional: 50 };
      },
    }),
    maxAiCredits: 100,
  });
  engine.getUsageSummary = () => ({ hasCreditData: true, aiCredits: 157.25 });

  await engine.checkAiCreditBudget('after task T2');

  assert.equal(decisions[0].kind, 'ai_credits');
  assert.equal(engine.aiCreditCeiling, 207.25);
});

test('resume from strong-review findings starts with remediation rather than implementation', async () => {
  const modes = [];
  let resumedAt;
  const a = sessionAgent('A');
  const b = sessionAgent('B');
  const reviewer = sessionAgent('Strong reviewer');
  const factory = {
    async createWorker(_key, name) { return name === 'A' ? a : b; },
    async createReviewer() { return reviewer; },
  };
  const engine = new ResumableConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => 'R3',
    maxReviewerCycles: 3,
  });
  engine.runWorkerPass = async (worker, _task, mode) => {
    modes.push(mode);
    return {
      worker: worker.name,
      report: { verdict: 'changed', summary: 'fixed saved finding', findings: [], checks: [] },
      changed: true,
      revision: 'R4',
    };
  };
  engine.convergeWorkers = async () => ({ revision: 'R4', evidence: [{ agent: 'Worker A', check: 'focused test passed' }] });
  engine.runStrongReview = async (_task, _a, _b, _reviewer, evidence, _routing, options) => {
    resumedAt = { evidence, options };
  };

  await engine.runFullTask(factory, task, '5-T5', routing, {
    stage: 'strong_review_findings',
    reviewCycle: 3,
    findings: [{ severity: 'high', title: 'Remaining issue', description: 'one detail still needs correction' }],
  });

  assert.deepEqual(modes, ['FIX_STRONG_REVIEW_FINDINGS']);
  assert.equal(resumedAt.options.startReviewCycle, 4);
  assert.deepEqual(resumedAt.evidence, [{ agent: 'Worker A', check: 'focused test passed' }]);
});

test('blocked worker can hand the preserved revision to its peer instead of failing convergence', async () => {
  const checkpoints = [];
  const a = sessionAgent('A');
  const b = sessionAgent('B');
  const sequence = [
    {
      worker: 'B',
      report: { verdict: 'blocked', summary: 'required validation dependency unavailable', findings: [], checks: ['partial validation passed'] },
      changed: false,
      revision: 'R1',
    },
    {
      worker: 'A',
      report: { verdict: 'clean', summary: 'current revision remains acceptable', findings: [], checks: [] },
      changed: false,
      revision: 'R1',
    },
    {
      worker: 'B',
      report: { verdict: 'clean', summary: 'peer independently validated the revision', findings: [], checks: ['alternative validation passed'] },
      changed: false,
      revision: 'R1',
    },
  ];
  const engine = new ResumableConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => 'R1',
    userInputHandler: async (request) => ({ answer: request.choices[0], wasFreeform: false }),
    onCheckpoint: async (state) => checkpoints.push(state),
  });
  engine.activeTaskCheckpointContext = { request: 'do work', plan: { tasks: [task] }, index: 0 };
  engine.runWorkerPass = async () => sequence.shift();

  const initial = {
    worker: 'A',
    report: { verdict: 'changed', summary: 'implemented', findings: [], checks: [] },
    changed: true,
    revision: 'R1',
  };
  const result = await engine.convergeWorkers(task, a, b, b, initial, { nextReviewCycle: 1, routing });

  assert.equal(result.revision, 'R1');
  assert.equal(sequence.length, 0);
  assert.ok(checkpoints.some((state) => state.taskState?.stage === 'worker_blocked'));
});

test('blocked worker can pause with its blocker and revision checkpointed', async () => {
  const checkpoints = [];
  const a = sessionAgent('A');
  const b = sessionAgent('B');
  const blocked = {
    worker: 'A',
    report: { verdict: 'blocked', summary: 'toolchain path is not configured', findings: [], checks: ['available checks passed'] },
    changed: true,
    revision: 'R2',
  };
  const engine = new ResumableConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => 'R2',
    userInputHandler: async (request) => ({ answer: request.choices[2], wasFreeform: false }),
    onCheckpoint: async (state) => checkpoints.push(state),
  });
  engine.activeTaskCheckpointContext = { request: 'do work', plan: { tasks: [task] }, index: 0 };

  await assert.rejects(
    engine.convergeFromPass(task, a, b, blocked, routing, { nextReviewCycle: 1 }),
    (error) => error?.code === 'CONVERGENT_PAUSED',
  );

  const saved = checkpoints.find((state) => state.taskState?.stage === 'worker_blocked');
  assert.equal(saved.taskState.blockedPass.revision, 'R2');
  assert.equal(saved.taskState.blockedPass.report.summary, 'toolchain path is not configured');
});

test('blocked strong reviewer can retry the same review cycle instead of failing the task', async () => {
  const checkpoints = [];
  const reports = [
    { verdict: 'blocked', summary: 'validation environment unavailable', findings: [] },
    { verdict: 'clean', summary: 'review completed after retry', findings: [] },
  ];
  const reviewer = sessionAgent('Strong reviewer');
  reviewer.session.sendAndWait = async () => {
    reviewer.sink.value = reports.shift();
  };
  const engine = new ResumableConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => 'R3',
    userInputHandler: async (request) => ({ answer: request.choices[0], wasFreeform: false }),
    onCheckpoint: async (state) => checkpoints.push(state),
  });
  engine.activeTaskCheckpointContext = { request: 'do work', plan: { tasks: [task] }, index: 0 };
  engine.finishTurn = async () => ({});

  await engine.runStrongReview(task, sessionAgent('A'), sessionAgent('B'), reviewer, [], routing);

  assert.equal(reports.length, 0);
  assert.ok(checkpoints.some((state) => state.taskState?.stage === 'strong_review_blocked' && state.taskState.reviewCycle === 1));
});
