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

test('missing token prerequisite forces operator input before retrying a blocked worker', async () => {
  const events = [];
  const sink = { value: null };
  let sends = 0;
  const session = {
    sessionId: 'recovery-session',
    async sendAndWait() {
      sends += 1;
      sink.value = sends === 1
        ? {
            action: 'retry',
            rationale: 'Implementation is correct; retry the unchanged validation.',
            question: '',
            guidance: 'Rerun the external validator.',
          }
        : {
            action: 'retry',
            rationale: 'Operator supplied a benchmark-only token.',
            question: '',
            guidance: 'Use TASKFLOW_RELEASE_TOKEN=benchmark-only-secret only for the required validation command.',
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
    userInputHandler: async () => ({
      answer: 'Use TASKFLOW_RELEASE_TOKEN=benchmark-only-secret only for the external validation command.',
    }),
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

  assert.equal(sends, 2, 'operator answer must be returned to the recovery coordinator before a retry is accepted');
  assert.equal(decision.action, 'retry');
  assert.match(decision.guidance, /benchmark-only-secret/);
  assert.equal(events.some((event) => event.type === 'recovery_operator_prerequisite_required'), true);
  const recovery = events.find((event) => event.type === 'recovery_decision');
  assert.match(recovery.operatorAnswer, /benchmark-only-secret/);
});
