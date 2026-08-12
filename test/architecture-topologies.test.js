'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ARCHITECTURES,
  normalizeArchitecture,
  architectureMetadata,
  benchmarkTask,
  ExperimentalTopologyEngine,
} = require('../src/headless/topologies');

function quietUi() {
  return new Proxy({}, { get: () => () => {} });
}

function fakeWorker(name = 'A') {
  return {
    name,
    session: { sessionId: `worker-${name}` },
    sink: { value: null },
    usageName: `worker-${name}`,
    model: { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    reasoningEffort: 'medium',
  };
}

function fakeReviewer() {
  return {
    name: 'Strong reviewer',
    session: { sessionId: 'reviewer' },
    sink: { value: null },
    usageName: 'reviewer',
    model: { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    reasoningEffort: 'medium',
  };
}

class TestTopologyEngine extends ExperimentalTopologyEngine {
  constructor(architecture, behavior = {}) {
    super({
      architecture,
      client: {},
      sdk: {},
      workspace: '/tmp/fake-workspace',
      models: { available: [], workerASelector: 'strong', reviewer: { id: 'gpt-5.6-terra' }, flowMode: 'fast' },
      permissionHandler: async () => ({ kind: 'approve-once' }),
      userInputHandler: async () => ({ answer: '' }),
      ui: quietUi(),
      maxReviewerCycles: 3,
      revisionProvider: async () => 'revision-1',
      changeStateProvider: async () => null,
    });
    this.behavior = behavior;
    this.calls = [];
  }

  async validateWorkspace() {
    this.calls.push('validate-workspace');
  }

  createFactory() {
    const calls = this.calls;
    return {
      flowMode: 'fast',
      async createWorker(_taskId, worker) {
        calls.push(`create-worker-${worker}`);
        return fakeWorker(worker);
      },
      async createReviewer() {
        calls.push('create-reviewer');
        return fakeReviewer();
      },
      async createCoordinator() {
        calls.push('create-coordinator');
        throw new Error('experimental topology must not create coordinator');
      },
    };
  }

  async createTaskContext() {
    return { flowMode: 'fast', baselineChangeState: null };
  }

  async runWorkerPass(worker, _task, mode) {
    this.calls.push(`worker-${worker.name}-${mode}`);
    const reports = this.behavior.workerReports ?? [];
    const report = reports.shift() ?? { verdict: 'changed', findings: [], checks: ['tests passed'], summary: 'implemented' };
    return {
      worker: worker.name,
      report,
      changed: report.verdict === 'changed',
      revision: 'revision-1',
      durationMs: 1,
      usage: {},
      changeManifest: null,
    };
  }

  async reviewPass() {
    this.calls.push('review');
    const reviews = this.behavior.reviews ?? [];
    return reviews.shift() ?? { verdict: 'clean', findings: [], summary: 'clean' };
  }

  async disposeTaskSessions(sessions) {
    this.calls.push(`dispose-${sessions.filter(Boolean).length}`);
    this.sessions = [];
  }
}

test('architecture aliases normalize without conflating topology and model policy', () => {
  assert.equal(normalizeArchitecture(), ARCHITECTURES.CONVERGENT_V02);
  assert.equal(normalizeArchitecture('current'), ARCHITECTURES.CONVERGENT_V02);
  assert.equal(normalizeArchitecture('single'), ARCHITECTURES.SINGLE_AGENT);
  assert.equal(normalizeArchitecture('implementer+reviewer'), ARCHITECTURES.IMPLEMENTER_REVIEWER);
  assert.throws(() => normalizeArchitecture('five-random-agents'), /Unsupported benchmark architecture/);
});

test('architecture metadata keeps model selectors independent from topology', () => {
  assert.deepEqual(
    architectureMetadata('single-agent', { workerA: 'auto' }).selectors,
    { implementer: 'auto' },
  );
  const reviewer = architectureMetadata('implementer-reviewer', { workerA: 'strong', reviewer: 'strong' });
  assert.equal(reviewer.peerConvergence, false);
  assert.deepEqual(reviewer.activeRoles, ['implementer', 'strong-reviewer']);
  assert.deepEqual(reviewer.selectors, { implementer: 'strong', reviewer: 'strong' });
  assert.equal(architectureMetadata('convergent-v02').peerConvergence, true);
});

test('benchmark task preserves the whole request as one fixed topology-isolation task', () => {
  const task = benchmarkTask('Add dependencies and tests.');
  assert.equal(task.id, 'benchmark-task');
  assert.equal(task.description, 'Add dependencies and tests.');
  assert.equal(task.route, 'standard');
  assert.equal(task.risk, 'medium');
  assert.equal(task.acceptanceCriteria.length, 1);
});

test('single-agent topology creates only one implementer pass', async () => {
  const engine = new TestTopologyEngine('single-agent');
  const result = await engine.run('Implement the benchmark request.');

  assert.equal(result.architecture, 'single-agent');
  assert.deepEqual(
    engine.calls.filter((call) => call.startsWith('create-')),
    ['create-worker-A'],
  );
  assert.ok(engine.calls.includes('worker-A-IMPLEMENT'));
  assert.equal(engine.calls.includes('review'), false);
});

test('implementer-reviewer remediates through the same implementer without Worker B', async () => {
  const behavior = {
    reviews: [
      { verdict: 'findings', findings: [{ severity: 'medium', title: 'edge case', description: 'fix it' }], summary: 'one issue' },
      { verdict: 'clean', findings: [], summary: 'clean after remediation' },
    ],
    workerReports: [
      { verdict: 'changed', findings: [], checks: ['initial tests'], summary: 'implemented' },
      { verdict: 'changed', findings: [], checks: ['remediation tests'], summary: 'fixed reviewer finding' },
    ],
  };
  const engine = new TestTopologyEngine('implementer-reviewer', behavior);
  const result = await engine.run('Implement and validate the benchmark request.');

  assert.equal(result.architecture, 'implementer-reviewer');
  assert.ok(engine.calls.includes('create-worker-A'));
  assert.ok(engine.calls.includes('create-reviewer'));
  assert.equal(engine.calls.includes('create-worker-B'), false);
  assert.deepEqual(
    engine.calls.filter((call) => call.startsWith('worker-A-')),
    ['worker-A-IMPLEMENT', 'worker-A-FIX_STRONG_REVIEW_FINDINGS'],
  );
  assert.equal(engine.calls.filter((call) => call === 'review').length, 2);
});

test('released convergent-v02 cannot accidentally execute through the experimental engine', async () => {
  const engine = new TestTopologyEngine('convergent-v02');
  await assert.rejects(
    engine.run('Do work.'),
    /must use the released RecoveryConvergentEngine/,
  );
});
