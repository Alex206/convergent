'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResumableConvergentEngine } = require('../src/orchestrator/resumable-engine');
const pkg = require('../package.json');

function fakeUi() {
  return new Proxy({}, { get: () => () => {} });
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
  title: 'High-risk identity work',
  description: 'Fix the authenticated identity lifecycle',
  acceptanceCriteria: ['Identity remains unambiguous'],
};

const routing = { route: 'high_risk', risk: 'high' };

test('package default gives strong review a six-cycle safety ceiling', () => {
  const setting = pkg.contributes.configuration.properties['convergent.maxReviewerCycles'];
  assert.equal(setting.default, 6);
  assert.equal(setting.maximum, 20);
  assert.match(setting.description, /safety ceiling/i);
});

test('strong review checkpoints remaining findings and can continue beyond cycle three', async () => {
  const revision = { value: 'R1' };
  const checkpoints = [];
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
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => revision.value,
    maxReviewerCycles: 6,
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
  const findingCycles = checkpoints
    .filter((state) => state.taskState?.stage === 'strong_review_findings')
    .map((state) => state.taskState.reviewCycle);
  assert.deepEqual(findingCycles, [1, 2, 3]);
  assert.ok(checkpoints.some((state) => state.taskState?.stage === 'strong_review_pending' && state.taskState.nextReviewCycle === 4));
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
    maxReviewerCycles: 6,
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
    findings: [{ severity: 'high', title: 'Authentication gap', description: 'embedded identity is not authenticated' }],
  });

  assert.deepEqual(modes, ['FIX_STRONG_REVIEW_FINDINGS']);
  assert.equal(resumedAt.options.startReviewCycle, 4);
  assert.deepEqual(resumedAt.evidence, [{ agent: 'Worker A', check: 'focused test passed' }]);
});
