'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RecoveryConvergentEngine } = require('../src/orchestrator/recovery-engine');

const task = {
  id: 'release-signing-api',
  title: 'Add release signing',
  description: 'Add release signing and run the required external validator.',
  acceptanceCriteria: ['Required external validation is completed rather than silently weakened.'],
};

test('recovery coordinator structured action is not overridden by regex-parsing blocker prose', async () => {
  const events = [];
  const sink = { value: null };
  let sends = 0;
  const session = {
    sessionId: 'recovery-session',
    async sendAndWait() {
      sends += 1;
      sink.value = {
        action: 'retry',
        rationale: 'I evaluated the supplied blocker and a bounded retry is appropriate.',
        question: '',
        guidance: 'Retry once with the preserved workspace and report the exact result.',
      };
    },
    async disconnect() {},
  };

  const engine = new RecoveryConvergentEngine({
    client: {},
    sdk: {},
    workspace: '/repo',
    models: {},
    ui: {
      phase() {},
      log() {},
      audit(event) { events.push(event); },
    },
    userInputHandler: async () => {
      throw new Error('deterministic prose parsing must not force operator input');
    },
  });
  engine.finishTurn = async () => ({});
  engine.recoveryFactory = () => ({
    createRecoveryCoordinator: async () => ({ session, sink }),
  });

  const decision = await engine.consultRecoveryCoordinator(task, 'worker-A', {
    changed: true,
    workspaceFingerprint: 'workspace-fingerprint',
    summary: 'The unchanged external validator reported its explicit missing-token blocker.',
    checks: ['python tools/validate_release_signature.py: TASKFLOW_RELEASE_TOKEN is not configured'],
  }, { allowPeer: true });

  assert.equal(sends, 1);
  assert.equal(decision.action, 'retry');
  assert.equal(events.some((event) => event.type === 'recovery_operator_prerequisite_required'), false);
  const recovery = events.find((event) => event.type === 'recovery_decision');
  assert.equal(recovery?.report?.action, 'retry');
});
