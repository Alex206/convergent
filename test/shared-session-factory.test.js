'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ConvergentEngine } = require('../src/orchestrator/engine');
const { ResumableConvergentEngine } = require('../src/orchestrator/resumable-engine');
const { RecoveryConvergentEngine } = require('../src/orchestrator/recovery-engine');
const { OperatorCredentialGuard } = require('../src/copilot/operator-credential-guard');

function engineOptions(guard) {
  return {
    client: {},
    sdk: {},
    workspace: '/repo',
    models: {},
    ui: {},
    operatorCredentialGuard: guard,
  };
}

test('base session factory reuses the engine credential guard instance', () => {
  const guard = new OperatorCredentialGuard({ environment: {} });
  const engine = new ConvergentEngine(engineOptions(guard));
  const factory = engine.sessionFactory();
  assert.equal(factory.operatorCredentialGuard, guard);
});

test('resumable engine inherits the same session factory boundary', () => {
  const guard = new OperatorCredentialGuard({ environment: {} });
  const engine = new ResumableConvergentEngine({ ...engineOptions(guard), onCheckpoint: async () => {} });
  const factory = engine.sessionFactory();
  assert.equal(factory.operatorCredentialGuard, guard);
});

test('recovery coordinator factory and task factory share one credential guard', () => {
  const guard = new OperatorCredentialGuard({ environment: {} });
  const engine = new RecoveryConvergentEngine({ ...engineOptions(guard), onCheckpoint: async () => {} });
  const taskFactory = engine.sessionFactory();
  const recoveryFactory = engine.recoveryFactory();
  assert.equal(taskFactory.operatorCredentialGuard, guard);
  assert.equal(recoveryFactory.operatorCredentialGuard, guard);
  assert.equal(taskFactory.operatorCredentialGuard, recoveryFactory.operatorCredentialGuard);
});
