'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ReviewArchitectureEngine } = require('../src/orchestrator/review-architecture-engine');

function ui() {
  return { log() {}, audit() {}, auditEvent() {}, phase() {} };
}

function engine(options = {}) {
  return new ReviewArchitectureEngine({
    client: {},
    sdk: {},
    workspace: '/repo',
    workspaceFolders: [{ name: 'repo', path: '/repo' }],
    models: {},
    ui: ui(),
    revisionProvider: async () => 'R1',
    changeStateProvider: async () => null,
    ...options,
  });
}

test('unchanged resume cannot reinterpret reviewer-integrity checkpoint as ordinary findings', async () => {
  const value = engine();
  await assert.rejects(
    () => value.runTask(
      {},
      { id: 'T1', title: 'Task' },
      '1-T1',
      { route: 'standard', risk: 'medium' },
      {
        stage: 'strong_review_findings',
        reviewCycle: 2,
        findings: [],
        integrityIncident: { reviewCycle: 2, beforeRevision: 'R0', afterRevision: 'R1' },
        reviewDossier: { cycles: [{ cycle: 2, revision: 'R1', integrityIncident: { reviewCycle: 2 } }] },
      },
    ),
    /reviewer-integrity boundary/i,
  );
});

test('checkpoint persists cumulative usage ledger alongside review architecture', async () => {
  let persisted = null;
  const value = engine({ onCheckpoint: async (state) => { persisted = state; } });
  const session = { sessionId: 'worker-a' };
  value.usage.register('1-T1:worker-a', session, { id: 'luna', name: 'GPT-5.6 Luna' }, 'Worker A');
  value.usage.recordAssistantUsage('1-T1:worker-a', { inputTokens: 100, outputTokens: 10, reasoningTokens: 5 });
  value.usage.recordCheckpoint('1-T1:worker-a', { totalNanoAiu: 500_000_000 });
  value.usage.recordTurn('1-T1:worker-a', 250);

  await value.saveCheckpoint({
    request: 'test request',
    status: 'running',
    stage: 'test',
    nextTaskIndex: 0,
    currentTaskIndex: 0,
  });

  assert.ok(persisted);
  assert.equal(persisted.reviewArchitecture, 'luna-specialized');
  assert.equal(persisted.usageLedger.inputTokens, 100);
  assert.equal(persisted.usageLedger.outputTokens, 10);
  assert.equal(persisted.usageLedger.aiCredits, 0.5);
  assert.equal(persisted.usageLedger.agents[0].agent, '1-T1:worker-a');
});