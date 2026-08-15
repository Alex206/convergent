'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTaskRoute, routePolicy, usesPeerConvergence } = require('../src/orchestrator/routing');
const { ResumableConvergentEngine } = require('../src/orchestrator/resumable-engine');
const { RecoveryConvergentEngine } = require('../src/orchestrator/recovery-engine');

function fakeUi(overrides = {}) {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return target[property];
      return () => {};
    },
  });
}

function agent(name) {
  return {
    name,
    sink: { value: null },
    model: { id: name.toLowerCase().replaceAll(' ', '-'), name },
    reasoningEffort: 'low',
    session: { async disconnect() {}, async abort() {} },
  };
}

const task = {
  id: 'adaptive-topology',
  title: 'Implement ordinary behavior',
  description: 'Implement the requested executable behavior and focused tests.',
  acceptanceCriteria: ['Behavior is correct', 'Focused tests pass'],
};

const standard = { route: 'standard', risk: 'medium', peerConvergence: false };
const highRisk = { route: 'high_risk', risk: 'high', peerConvergence: true };

function factory(created) {
  return {
    async createWorker(_key, name) {
      created.push(`worker-${name}`);
      return agent(name);
    },
    async createReviewer() {
      created.push('reviewer');
      return agent('Strong reviewer');
    },
  };
}

test('adaptive standard route uses implementer + strong reviewer while full override retains A/B convergence', () => {
  const adaptive = normalizeTaskRoute({ ...task, route: 'standard', risk: 'medium' }, 'adaptive');
  assert.equal(adaptive.route, 'standard');
  assert.equal(adaptive.peerConvergence, false);
  assert.equal(usesPeerConvergence(adaptive), false);
  assert.equal(routePolicy(adaptive.route, adaptive.risk, adaptive.peerConvergence).workerMode, 'implementer_review');

  const full = normalizeTaskRoute({ ...task, route: 'standard', risk: 'medium' }, 'full');
  assert.equal(full.route, 'standard');
  assert.equal(full.peerConvergence, true);
  assert.equal(usesPeerConvergence(full), true);
  assert.equal(routePolicy(full.route, full.risk, full.peerConvergence).workerMode, 'converge');
});

test('high-risk route always retains peer convergence', () => {
  const routing = normalizeTaskRoute({
    ...task,
    route: 'standard',
    risk: 'low',
    title: 'Fix authentication token handling',
  });
  assert.equal(routing.route, 'high_risk');
  assert.equal(routing.peerConvergence, true);
  assert.equal(usesPeerConvergence(routing), true);
});

test('standard full task creates Worker A and reviewer but no Worker B', async () => {
  const created = [];
  const calls = [];
  class TestEngine extends ResumableConvergentEngine {
    async runWorkerPass(worker, _task, mode) {
      calls.push(`${worker.name}:${mode}`);
      return {
        worker: worker.name,
        report: { verdict: 'changed', summary: 'implemented', findings: [], checks: ['tests passed'] },
        changed: true,
        revision: 'R1',
      };
    }
    async runStrongReview(_task, _a, b, _reviewer, evidence) {
      calls.push(`review:B=${Boolean(b)}:evidence=${evidence.length}`);
    }
    async disposeTaskSessions() {}
  }
  const engine = new TestEngine({ client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(), revisionProvider: async () => 'R1' });
  await engine.runFullTask(factory(created), task, '1-task', standard);
  assert.deepEqual(created, ['worker-A', 'reviewer']);
  assert.deepEqual(calls, ['A:IMPLEMENT', 'review:B=false:evidence=1']);
});

test('high-risk full task still creates Worker B and converges before strong review', async () => {
  const created = [];
  const calls = [];
  class TestEngine extends ResumableConvergentEngine {
    async runWorkerPass(worker, _task, mode) {
      calls.push(`${worker.name}:${mode}`);
      return {
        worker: worker.name,
        report: { verdict: 'changed', summary: 'implemented', findings: [], checks: [] },
        changed: true,
        revision: 'R1',
      };
    }
    async convergeFromPass(_task, _a, b) {
      calls.push(`converge:B=${Boolean(b)}`);
      return { revision: 'R1', evidence: [{ agent: 'A', check: 'tests passed' }] };
    }
    async runStrongReview(_task, _a, b) {
      calls.push(`review:B=${Boolean(b)}`);
    }
    async disposeTaskSessions() {}
  }
  const engine = new TestEngine({ client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(), revisionProvider: async () => 'R1' });
  await engine.runFullTask(factory(created), task, '1-task', highRisk);
  assert.deepEqual(created, ['worker-A', 'worker-B', 'reviewer']);
  assert.deepEqual(calls, ['A:IMPLEMENT', 'converge:B=true', 'review:B=true']);
});

test('standard reviewer findings return to the same Worker A without peer convergence', async () => {
  const reviewer = agent('Strong reviewer');
  const reports = [
    { verdict: 'findings', summary: 'fix edge case', findings: [{ severity: 'medium', title: 'edge', description: 'fix it' }], checks: [] },
    { verdict: 'clean', summary: 'clean', findings: [], checks: ['tests passed'] },
  ];
  reviewer.session.sendAndWait = async () => { reviewer.sink.value = reports.shift(); };
  const calls = [];
  class TestEngine extends ResumableConvergentEngine {
    async runWorkerPass(worker, _task, mode) {
      calls.push(`${worker.name}:${mode}`);
      return {
        worker: worker.name,
        report: { verdict: 'changed', summary: 'fixed', findings: [], checks: ['tests passed'] },
        changed: true,
        revision: 'R2',
      };
    }
    async convergeFromPass() {
      calls.push('unexpected-convergence');
      return { revision: 'R2', evidence: [] };
    }
  }
  const engine = new TestEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(), revisionProvider: async () => 'R2',
    onCheckpoint: async () => {}, maxReviewerCycles: 2,
  });
  engine.finishTurn = async () => ({});
  await engine.runStrongReview(task, agent('A'), null, reviewer, [{ agent: 'A', check: 'initial tests passed' }], standard);
  assert.deepEqual(calls, ['A:FIX_STRONG_REVIEW_FINDINGS']);
  assert.equal(reports.length, 0);
});

test('standard blocked recovery does not offer or route to a peer worker', async () => {
  const engine = new RecoveryConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(), revisionProvider: async () => 'R1',
    onCheckpoint: async () => {},
  });
  engine.activeTaskCheckpointContext = { request: 'work', plan: { tasks: [task] }, index: 0 };
  let allowPeerSeen = null;
  engine.consultRecoveryCoordinator = async (_task, _kind, _detail, options) => {
    allowPeerSeen = options.allowPeer;
    return { action: 'retry', rationale: 'retry same worker', guidance: 'retry' };
  };
  const worker = agent('A');
  worker.session.sendAndWait = async () => {};
  const result = {
    worker: 'A',
    report: { verdict: 'blocked', summary: 'missing prerequisite', findings: [], checks: [] },
    changed: false,
    revision: 'R1',
  };
  const decision = await engine.requestWorkerBlockedDecision(task, worker, null, result, standard);
  assert.equal(allowPeerSeen, false);
  assert.equal(decision.action, 'retry');
});

test('high-risk blocked recovery can still route to Worker B', async () => {
  const engine = new RecoveryConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(), revisionProvider: async () => 'R1',
    onCheckpoint: async () => {},
  });
  engine.activeTaskCheckpointContext = { request: 'work', plan: { tasks: [task] }, index: 0 };
  let allowPeerSeen = null;
  engine.consultRecoveryCoordinator = async (_task, _kind, _detail, options) => {
    allowPeerSeen = options.allowPeer;
    return { action: 'peer', rationale: 'independent peer can resolve', guidance: 'inspect current revision' };
  };
  const a = agent('A');
  const b = agent('B');
  b.session.sendAndWait = async () => {};
  const result = {
    worker: 'A',
    report: { verdict: 'blocked', summary: 'needs independent inspection', findings: [], checks: [] },
    changed: true,
    revision: 'R1',
  };
  const decision = await engine.requestWorkerBlockedDecision(task, a, b, result, highRisk);
  assert.equal(allowPeerSeen, true);
  assert.equal(decision.action, 'peer');
});
