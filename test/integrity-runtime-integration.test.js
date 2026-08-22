'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ConvergentEngine } = require('../src/orchestrator/engine');
const { SessionFactory, workerHook, readonlyHook } = require('../src/copilot/session-factory');
const { OperatorCredentialGuard } = require('../src/copilot/operator-credential-guard');

function fakeUi() {
  return new Proxy({}, { get: () => () => {} });
}

const task = {
  id: 'integrity-runtime',
  title: 'Validate integrity wiring',
  description: 'Exercise deterministic integrity boundaries.',
  acceptanceCriteria: ['Structured verdicts remain authoritative unless Convergent has deterministic contrary evidence.'],
};

test('SessionFactory pre-tool boundary combines role policy with credential provenance for JSON-string hook args', () => {
  const factory = Object.create(SessionFactory.prototype);
  factory.operatorCredentialGuard = new OperatorCredentialGuard({ environment: {} });

  const deniedCredential = factory.preToolUse(workerHook, 'Worker A', {
    toolName: 'bash',
    toolArgs: JSON.stringify({ command: 'TASKFLOW_RELEASE_TOKEN=made-up python validator.py' }),
  });
  assert.equal(deniedCredential.permissionDecision, 'deny');
  assert.match(deniedCredential.permissionDecisionReason, /TASKFLOW_RELEASE_TOKEN/);

  const ordinary = factory.preToolUse(workerHook, 'Worker A', {
    toolName: 'bash',
    toolArgs: JSON.stringify({ command: 'NODE_ENV=test node --test' }),
  });
  assert.equal(ordinary.permissionDecision, 'allow');

  const readonlyMutation = factory.preToolUse(readonlyHook, 'Strong reviewer', {
    toolName: 'builtin:bash',
    toolArgs: JSON.stringify({ command: 'echo bad > result.txt' }),
  });
  assert.equal(readonlyMutation.permissionDecision, 'deny');
  assert.match(readonlyMutation.permissionDecisionReason, /read-only/i);
});

test('worker pass keeps CLEAN when only free-form validation prose sounds blocked', async () => {
  const sink = { value: null };
  const worker = {
    name: 'A',
    sink,
    session: {
      async sendAndWait() {
        sink.value = {
          verdict: 'clean',
          summary: 'Implementation is complete.',
          findings: [],
          checks: [
            'Focused tests passed',
            'Required external validator exited 2 because TASKFLOW_RELEASE_TOKEN is not configured.',
          ],
        };
      },
    },
  };
  const engine = new ConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => 'R1',
  });

  const result = await engine.runWorkerPass(worker, task, 'IMPLEMENT', null);
  assert.equal(result.report.verdict, 'clean');
  assert.equal(result.verdictCorrection, null);
});

test('strong reviewer CLEAN is not semantically reinterpreted from check wording', async () => {
  const sink = { value: null };
  const reviewer = {
    name: 'Strong reviewer',
    sink,
    session: {
      async sendAndWait() {
        sink.value = {
          verdict: 'clean',
          summary: 'Implementation is correct.',
          findings: [],
          checks: [
            'Focused tests passed',
            'Required external validation blocked as expected because TASKFLOW_RELEASE_TOKEN is unavailable.',
          ],
        };
      },
    },
  };
  const engine = new ConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => 'R1',
  });

  await engine.runStrongReview(task, {}, {}, reviewer, [], { route: 'standard', risk: 'medium' });
});

test('worker report is forced BLOCKED after a denied synthetic credential assignment', async () => {
  const credentialGuard = new OperatorCredentialGuard({ environment: {} });
  const denied = credentialGuard.hook({
    toolName: 'bash',
    toolArgs: JSON.stringify({ command: 'CLIENT_SECRET=made-up python validator.py' }),
  }, { agent: 'Worker A' });
  assert.equal(denied.permissionDecision, 'deny');

  const sink = { value: null };
  const worker = {
    name: 'A',
    sink,
    session: {
      async sendAndWait() {
        sink.value = {
          verdict: 'clean',
          summary: 'Implementation is complete. No unresolved issues.',
          findings: [],
          checks: ['Focused tests passed'],
        };
      },
    },
  };
  const engine = new ConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => 'R1',
    operatorCredentialGuard: credentialGuard,
  });

  const result = await engine.runWorkerPass(worker, task, 'IMPLEMENT', null);
  assert.equal(result.report.verdict, 'blocked');
  assert.match(result.report.summary, /Operator context is required/);
  assert.match(result.report.checks.join('\n'), /CLIENT_SECRET/);
  assert.doesNotMatch(JSON.stringify(result.report), /made-up/);
});
