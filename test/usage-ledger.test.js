'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUsageSnapshot,
  mergeUsageSnapshots,
  usageDelta,
  taskIdFromAgent,
} = require('../src/orchestrator/usage-ledger');

test('usage ledger accepts an empty/null checkpoint', () => {
  const empty = normalizeUsageSnapshot(null);
  assert.equal(empty.inputTokens, 0);
  assert.equal(empty.aiCredits, 0);
  assert.deepEqual(empty.agents, []);
});

test('usage ledger merges prior request usage with current execution without pause downtime', () => {
  const prior = {
    elapsedMs: 1000,
    agents: [{
      agent: '1-T1:worker-a',
      label: 'Worker A',
      model: 'GPT-5.6 Luna',
      modelId: 'luna',
      calls: 2,
      turns: 1,
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 10,
      totalNanoAiu: 1_000_000_000,
      hasCreditData: true,
      durationMs: 700,
    }],
  };
  const current = {
    elapsedMs: 500,
    agents: [
      {
        agent: '1-T1:worker-a',
        label: 'Worker A',
        model: 'GPT-5.6 Luna',
        modelId: 'luna',
        calls: 1,
        turns: 1,
        inputTokens: 50,
        outputTokens: 5,
        totalNanoAiu: 500_000_000,
        hasCreditData: true,
        durationMs: 300,
      },
      {
        agent: '1-T1:reviewer-adversarial-security',
        label: 'Adversarial & security reviewer',
        model: 'GPT-5.6 Luna',
        modelId: 'luna',
        calls: 1,
        turns: 1,
        inputTokens: 80,
        outputTokens: 8,
        totalNanoAiu: 250_000_000,
        hasCreditData: true,
        durationMs: 200,
      },
    ],
  };

  const merged = mergeUsageSnapshots(prior, current);
  assert.equal(merged.elapsedMs, 1500);
  assert.equal(merged.run.elapsedMs, 500);
  assert.equal(merged.inputTokens, 230);
  assert.equal(merged.outputTokens, 33);
  assert.equal(merged.aiCredits, 1.75);
  assert.equal(merged.tasks.length, 1);
  assert.equal(merged.tasks[0].taskId, '1-T1');
  assert.equal(merged.tasks[0].inputTokens, 230);
  assert.match(merged.agents[0].label, /^1-T1 · /);
});

test('usage delta isolates one review attempt', () => {
  const delta = usageDelta(
    { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, calls: 2, turns: 1, totalNanoAiu: 1_000_000_000, elapsedMs: 1000, hasCreditData: true },
    { inputTokens: 180, outputTokens: 28, reasoningTokens: 17, calls: 4, turns: 2, totalNanoAiu: 1_500_000_000, elapsedMs: 1400, hasCreditData: true },
  );
  assert.equal(delta.inputTokens, 80);
  assert.equal(delta.outputTokens, 8);
  assert.equal(delta.reasoningTokens, 12);
  assert.equal(delta.calls, 2);
  assert.equal(delta.turns, 1);
  assert.equal(delta.aiCredits, 0.5);
  assert.equal(delta.elapsedMs, 400);
});

test('task id is derived from persistent task-local usage keys only', () => {
  assert.equal(taskIdFromAgent('2-T7:reviewer-contract-integration'), '2-T7');
  assert.equal(taskIdFromAgent('coordinator'), null);
});