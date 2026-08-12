'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RECOVERY_POLICIES,
  normalizeRecoveryPolicy,
  architectureMetadata,
  ExperimentalTopologyEngine,
} = require('../src/headless/topologies');
const {
  evaluateArchitectureScenario04Recovery,
} = require('../src/headless/scenario04-architecture-acceptance');

function quietUi() {
  return new Proxy({}, { get: () => () => {} });
}

class RecoveryProbeEngine extends ExperimentalTopologyEngine {
  constructor(recoveryPolicy) {
    super({
      architecture: 'implementer-reviewer',
      recoveryPolicy,
      client: {},
      sdk: {},
      workspace: '/tmp/fake-workspace',
      models: {
        coordinator: { id: 'gpt-5.6-terra', name: 'Terra' },
        reviewer: { id: 'gpt-5.6-terra', name: 'Terra' },
        available: [],
        workerASelector: 'strong',
        flowMode: 'fast',
      },
      permissionHandler: async () => ({ kind: 'approve-once' }),
      userInputHandler: async () => ({ answer: 'benchmark token' }),
      ui: quietUi(),
      maxWorkerPasses: 3,
      maxReviewerCycles: 3,
      revisionProvider: async () => 'revision-1',
      changeStateProvider: async () => null,
    });
    this.calls = [];
    this.nextPass = null;
  }

  async consultRecoveryCoordinator(task, kind, detail, options) {
    this.calls.push({ type: 'recovery', task: task.id, kind, detail, options });
    return {
      action: 'retry',
      rationale: 'Operator supplied the missing validation prerequisite.',
      guidance: 'Use TASKFLOW_RELEASE_TOKEN=benchmark-only-secret only for the validation command.',
    };
  }

  async runWorkerPass(worker, _task, mode) {
    this.calls.push({ type: 'pass', worker: worker.name, mode });
    return this.nextPass ?? {
      worker: worker.name,
      report: { verdict: 'clean', summary: 'validation now succeeds', checks: ['validator passed'], findings: [] },
      changed: false,
      revision: 'revision-1',
    };
  }
}

function blockedPass() {
  return {
    worker: 'A',
    report: {
      verdict: 'blocked',
      summary: 'Required release validation is blocked because TASKFLOW_RELEASE_TOKEN is not configured.',
      checks: ['python tools/validate_release_signature.py -> exit 2: TASKFLOW_RELEASE_TOKEN is not configured'],
      findings: [],
    },
    changed: true,
    revision: 'revision-1',
  };
}

test('recovery policy normalizes independently from topology', () => {
  assert.equal(normalizeRecoveryPolicy(), RECOVERY_POLICIES.NONE);
  assert.equal(normalizeRecoveryPolicy('on-demand'), RECOVERY_POLICIES.STRONG_COORDINATOR);
  assert.equal(normalizeRecoveryPolicy('coordinator'), RECOVERY_POLICIES.STRONG_COORDINATOR);
  assert.throws(() => normalizeRecoveryPolicy('magic'), /Unsupported recovery policy/);

  const normal = architectureMetadata('implementer-reviewer', { recoveryPolicy: 'none' });
  const recovered = architectureMetadata('implementer-reviewer', { recoveryPolicy: 'strong-coordinator' });
  assert.equal(normal.recoveryPolicy, 'none');
  assert.deepEqual(normal.conditionalRoles, []);
  assert.equal(recovered.recoveryPolicy, 'strong-coordinator');
  assert.deepEqual(recovered.conditionalRoles, ['strong-recovery-coordinator']);
  assert.deepEqual(normal.activeRoles, recovered.activeRoles);
});

test('recovery=none stops on a blocked implementer instead of silently approving it', async () => {
  const engine = new RecoveryProbeEngine('none');
  await assert.rejects(
    engine.recoverBlockedImplementer(
      { name: 'A', session: {} },
      { id: 'task' },
      blockedPass(),
      { route: 'standard', risk: 'medium' },
      {},
    ),
    /Implementer is blocked/,
  );
  assert.equal(engine.calls.length, 0);
});

test('on-demand recovery invokes strong recovery coordinator only after BLOCKED and retries same implementer', async () => {
  const engine = new RecoveryProbeEngine('strong-coordinator');
  const worker = { name: 'A', session: { sendAndWait: async () => {} } };
  const recovered = await engine.recoverBlockedImplementer(
    worker,
    { id: 'task' },
    blockedPass(),
    { route: 'standard', risk: 'medium' },
    {},
  );
  assert.equal(recovered.report.verdict, 'clean');
  assert.equal(engine.calls[0].type, 'recovery');
  assert.equal(engine.calls[0].options.allowPeer, false);
  assert.equal(engine.calls[1].type, 'pass');
  assert.equal(engine.calls[1].worker, 'A');
  assert.equal(engine.calls[1].mode, 'REVIEW_AND_FIX');
});

test('peer topologies reject an undefined recovery combination instead of silently changing semantics', () => {
  assert.throws(() => new RecoveryProbeEngine('none') && new ExperimentalTopologyEngine({
    architecture: 'peer-competition',
    recoveryPolicy: 'strong-coordinator',
    client: {}, sdk: {}, workspace: '/tmp/fake', models: {}, ui: quietUi(),
  }), /not yet implemented for peer-competition/);
});

test('topology-neutral Scenario 04 oracle accepts recovered implementer-reviewer without requiring peer convergence', () => {
  const events = [
    { type: 'worker_pass_result', report: { verdict: 'blocked' } },
    {
      type: 'recovery_decision',
      report: { action: 'retry' },
      operatorAnswer: 'Use TASKFLOW_RELEASE_TOKEN=benchmark-only-secret only for validation.',
    },
    { type: 'worker_pass_result', report: { verdict: 'clean' } },
    { type: 'strong_review_result', review: { verdict: 'clean' } },
    { type: 'task_complete' },
  ];
  const report = evaluateArchitectureScenario04Recovery(events);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(report.indices.convergenceIndex, -1);
});

test('topology-neutral Scenario 04 oracle still enforces convergence ordering when a peer topology emits it', () => {
  const events = [
    { type: 'worker_pass_result', report: { verdict: 'blocked' } },
    { type: 'recovery_decision', report: { action: 'retry' }, operatorAnswer: 'token' },
    { type: 'worker_pass_result', report: { verdict: 'changed' } },
    { type: 'worker_pass_result', report: { verdict: 'clean' } },
    { type: 'workers_converged' },
    { type: 'strong_review_result', review: { verdict: 'clean' } },
    { type: 'task_complete' },
  ];
  const report = evaluateArchitectureScenario04Recovery(events);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.ok(report.indices.convergenceIndex > report.indices.recoveredPassIndex);
});
