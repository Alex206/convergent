'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RecoveryConvergentEngine } = require('../src/orchestrator/recovery-engine');

function fakeUi(events = []) {
  return new Proxy({
    auditEvent(event) { events.push(event); },
    audit(event) { events.push(event); },
  }, { get(target, key) { return key in target ? target[key] : () => {}; } });
}

function fakeSession(id, order = []) {
  return {
    sessionId: id,
    calls: [],
    async sendAndWait(options) { this.calls.push(options); return {}; },
    async disconnect() { order.push(`disconnect:${id}`); },
  };
}

function runtimeStall({ proven = true, active = true } = {}) {
  const error = new Error('Worker A tool run_command stalled');
  error.code = 'CONVERGENT_TOOL_STALL';
  error.convergentDiagnostic = {
    currentTool: { id: 'tool-1', name: 'run_command', detail: 'TOKEN=secret command', durationMs: 5000, quietMs: 3000 },
    managedCommandTermination: {
      owner: 'Worker A', active, proven, commandId: 'cmd-1', pid: 321,
      method: 'posix-process-group', groupGone: proven,
    },
  };
  return error;
}

const task = {
  id: 'task-1',
  title: 'Implement behavior',
  description: 'Implement requested behavior',
  acceptanceCriteria: ['Tests pass'],
};
const routing = { route: 'standard', risk: 'medium', peerConvergence: false };

test('proven managed-command stall replaces worker with a fresh session and queues recovery guidance', async () => {
  const order = [];
  const events = [];
  const checkpoints = [];
  const createCalls = [];
  const oldSession = fakeSession('old-worker', order);
  const worker = { name: 'A', session: oldSession, usageName: 'old', model: { id: 'luna' } };
  const replacementSession = fakeSession('fresh-worker', order);
  const factory = {
    async createWorker(taskSessionKey, role, route, risk, attempt) {
      createCalls.push({ taskSessionKey, role, route, risk, attempt });
      return { name: role, session: replacementSession, usageName: 'fresh', model: { id: 'luna' }, reasoningEffort: 'low' };
    },
  };
  const engine = new RecoveryConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(events),
    revisionProvider: async () => 'REV-1',
    onCheckpoint: async (state) => checkpoints.push(state),
  });
  engine.activeTaskCheckpointContext = { request: 'do work', plan: { tasks: [task] }, index: 0 };
  engine.activeRuntimeRecoveryContext = { factory, taskSessionKey: 'task-1', routing, attempts: new Map() };
  engine.sessions.push(oldSession);
  engine.consultRecoveryCoordinator = async (_task, kind, detail, options) => {
    assert.equal(kind, 'worker-A-runtime-stall');
    assert.equal(detail.runtimeIncident.recoverable, true);
    assert.equal(options.allowPeer, false);
    return { action: 'retry', rationale: 'tree termination is proven', guidance: 'Re-inspect the preserved workspace and rerun focused validation.' };
  };

  const outcome = await engine.recoverRuntimeStallAgent(runtimeStall(), worker, task, 'worker');

  assert.equal(outcome.retry, true);
  assert.equal(worker.session, replacementSession);
  assert.deepEqual(createCalls, [{ taskSessionKey: 'task-1', role: 'A', route: 'standard', risk: 'medium', attempt: 'runtime-retry-1' }]);
  assert.deepEqual(order, ['disconnect:old-worker']);
  assert.ok(checkpoints.some((state) => state.taskState?.stage === 'worker_runtime_stall'));
  assert.ok(events.some((event) => event.type === 'runtime_stall_recovery'));
  await worker.session.sendAndWait({ prompt: 'retry' });
  assert.match(worker.session.calls[0].prompt, /RECOVERY GUIDANCE/i);
  assert.match(worker.session.calls[0].prompt, /preserved workspace/i);
  assert.doesNotMatch(JSON.stringify(events), /TOKEN=secret/);
});

test('unproven managed-command termination never creates a fresh worker', async () => {
  let creates = 0;
  const worker = { name: 'A', session: fakeSession('old-worker') };
  const engine = new RecoveryConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(), revisionProvider: async () => 'REV-X',
  });
  engine.activeTaskCheckpointContext = { request: 'do work', plan: { tasks: [task] }, index: 0 };
  engine.activeRuntimeRecoveryContext = {
    factory: { async createWorker() { creates += 1; throw new Error('must not create'); } },
    taskSessionKey: 'task-1', routing, attempts: new Map(),
  };

  await assert.rejects(
    () => engine.recoverRuntimeStallAgent(runtimeStall({ proven: false }), worker, task, 'worker'),
    /termination.*not proven|could not prove/i,
  );
  assert.equal(creates, 0);
});

test('agent inactivity without an active managed command is not auto-recoverable', async () => {
  const error = runtimeStall({ proven: true, active: false });
  error.code = 'CONVERGENT_AGENT_INACTIVITY';
  const worker = { name: 'A', session: fakeSession('old-worker') };
  const engine = new RecoveryConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(), revisionProvider: async () => 'REV-X',
  });
  engine.activeRuntimeRecoveryContext = { factory: {}, taskSessionKey: 'task-1', routing, attempts: new Map() };

  const outcome = await engine.recoverRuntimeStallAgent(error, worker, task, 'worker');
  assert.equal(outcome, null);
});

test('reviewer runtime recovery creates a fresh reviewer attempt and preserves route', async () => {
  const oldSession = fakeSession('old-reviewer');
  const replacementSession = fakeSession('fresh-reviewer');
  const reviewer = { name: 'Strong reviewer', session: oldSession };
  const calls = [];
  const factory = {
    async createReviewer(taskSessionKey, route, risk, attempt) {
      calls.push({ taskSessionKey, route, risk, attempt });
      return { name: 'Strong reviewer', session: replacementSession, usageName: 'reviewer-fresh', model: { id: 'terra' }, reasoningEffort: 'medium' };
    },
  };
  const engine = new RecoveryConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(), revisionProvider: async () => 'REV-R',
  });
  engine.activeTaskCheckpointContext = { request: 'do work', plan: { tasks: [task] }, index: 0 };
  engine.activeRuntimeRecoveryContext = { factory, taskSessionKey: 'task-1', routing, attempts: new Map() };
  engine.consultRecoveryCoordinator = async () => ({ action: 'retry', rationale: 'safe', guidance: 'Review the preserved revision again.' });

  const outcome = await engine.recoverRuntimeStallAgent(runtimeStall(), reviewer, task, 'reviewer');

  assert.equal(outcome.retry, true);
  assert.equal(reviewer.session, replacementSession);
  assert.deepEqual(calls, [{ taskSessionKey: 'task-1', route: 'standard', risk: 'medium', attempt: 'runtime-retry-1' }]);
});
