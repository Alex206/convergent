'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RecoveryConvergentEngine, queueRecoveryInstruction, appendTaskChangeManifestPrompt } = require('../src/orchestrator/recovery-engine');
const { normalizeRecoveryReport, validateRecoveryReport } = require('../src/copilot/tools');

function fakeUi() {
  return new Proxy({}, { get: () => () => {} });
}

const task = {
  id: 'T2',
  title: 'Implement behavior',
  description: 'Implement the requested behavior',
  acceptanceCriteria: ['Behavior is correct'],
};

const routing = { route: 'high_risk', risk: 'high' };

function fakeSession() {
  return {
    calls: [],
    async sendAndWait(options) {
      this.calls.push(options);
      return {};
    },
  };
}

test('recovery report requires a question only when asking the operator', () => {
  const invalid = normalizeRecoveryReport({ action: 'ask_user', rationale: 'missing fact', question: '', guidance: '' });
  assert.match(validateRecoveryReport(invalid), /question/i);
  const valid = normalizeRecoveryReport({ action: 'retry', rationale: 'environment is ready', question: '', guidance: 'rerun focused validation' });
  assert.equal(validateRecoveryReport(valid), null);
});

test('queued recovery guidance is injected exactly once into the next normal agent turn', async () => {
  const session = fakeSession();
  assert.equal(queueRecoveryInstruction(session, 'Use the CI-only compiler validation path.'), true);
  await session.sendAndWait({ prompt: 'retry blocker' });
  await session.sendAndWait({ prompt: 'later pass' });
  assert.match(session.calls[0].prompt, /RECOVERY GUIDANCE/i);
  assert.match(session.calls[0].prompt, /CI-only compiler/i);
  assert.equal(session.calls[1].prompt, 'later pass');
});

test('recovery reviewer prompt carries deterministic task-change paths', () => {
  const prompt = appendTaskChangeManifestPrompt('review task', {
    baselineHead: 'A',
    currentHead: 'A',
    count: 2,
    entries: [
      { path: 'taskflow/config.py', status: ' M', kind: 'changed_since_task_start' },
      { path: 'tests/test_config.py', status: ' M', kind: 'changed_since_task_start' },
    ],
  });
  assert.match(prompt, /Deterministic task change manifest/i);
  assert.match(prompt, /taskflow\/config\.py/);
  assert.match(prompt, /tests\/test_config\.py/);
  assert.match(prompt, /instead of rediscovering file locations/i);
});

test('worker blocker follows strong recovery coordinator retry and preserves approval semantics', async () => {
  const checkpoints = [];
  const blockedWorker = { name: 'A', session: fakeSession() };
  const peerWorker = { name: 'B', session: fakeSession() };
  const engine = new RecoveryConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => 'R1',
    onCheckpoint: async (state) => checkpoints.push(state),
  });
  engine.activeTaskCheckpointContext = { request: 'do work', plan: { tasks: [task] }, index: 0 };
  engine.consultRecoveryCoordinator = async () => ({
    action: 'retry',
    rationale: 'implementation is complete; retry the environment validation',
    guidance: 'The missing tool is available in CI; use the established CI validation path.',
  });

  const decision = await engine.requestWorkerBlockedDecision(task, blockedWorker, peerWorker, {
    worker: 'A',
    changed: true,
    revision: 'R1',
    report: { verdict: 'blocked', summary: 'compiler unavailable locally', checks: ['unit tests passed'], findings: [] },
  }, routing);

  assert.equal(decision.action, 'retry');
  assert.ok(checkpoints.some((state) => state.taskState?.stage === 'worker_blocked'));
  await blockedWorker.session.sendAndWait({ prompt: 'retry now' });
  assert.match(blockedWorker.session.calls[0].prompt, /established CI validation path/i);
});

test('worker blocker can be handed to peer with coordinator guidance', async () => {
  const blockedWorker = { name: 'A', session: fakeSession() };
  const peerWorker = { name: 'B', session: fakeSession() };
  const engine = new RecoveryConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(), revisionProvider: async () => 'R1',
  });
  engine.activeTaskCheckpointContext = { request: 'do work', plan: { tasks: [task] }, index: 0 };
  engine.consultRecoveryCoordinator = async () => ({ action: 'peer', rationale: 'independent inspection useful', guidance: 'Check whether an alternative validation already exists.' });

  const decision = await engine.requestWorkerBlockedDecision(task, blockedWorker, peerWorker, {
    worker: 'A', changed: false, revision: 'R1',
    report: { verdict: 'blocked', summary: 'validation dependency unavailable', checks: [], findings: [] },
  }, routing);

  assert.equal(decision.action, 'peer');
  await peerWorker.session.sendAndWait({ prompt: 'peer review' });
  assert.match(peerWorker.session.calls[0].prompt, /alternative validation/i);
});

test('reviewer retry receives coordinator recovery guidance on its next review turn', async () => {
  const reviewer = { name: 'Strong reviewer', session: fakeSession() };
  const engine = new RecoveryConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(), revisionProvider: async () => 'R2',
  });
  engine.activeTaskCheckpointContext = { request: 'do work', plan: { tasks: [task] }, index: 0 };
  engine.activeReviewerForRecovery = reviewer;
  engine.consultRecoveryCoordinator = async () => ({ action: 'retry', rationale: 'false environment assumption', guidance: 'The current workspace fingerprint is not a Git commit id; review the current files.' });

  const decision = await engine.requestReviewerBlockedDecision(
    task,
    { verdict: 'blocked', summary: 'revision does not resolve', findings: [], checks: [] },
    1,
    [],
    routing,
  );

  assert.equal(decision.action, 'retry');
  await reviewer.session.sendAndWait({ prompt: 'review again' });
  assert.match(reviewer.session.calls[0].prompt, /not a Git commit id/i);
});