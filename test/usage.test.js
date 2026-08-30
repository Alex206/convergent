'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { UsageTracker, aiCreditsFromNanoAiu, usageDelta, USAGE_STATE_VERSION, taskIdFromAgent } = require('../src/orchestrator/usage');

test('nano-AIU conversion follows the SDK display convention', () => {
  assert.equal(aiCreditsFromNanoAiu(1_000_000_000), 1);
  assert.equal(aiCreditsFromNanoAiu(250_000_000), 0.25);
});

test('usage tracker aggregates tokens credits cache reasoning and context across persistent sessions', () => {
  const usage = new UsageTracker(1000);
  usage.register('task1:a', { sessionId: 'a' }, { id: 'haiku', name: 'Haiku' }, 'Worker A');
  usage.register('task1:b', { sessionId: 'b' }, { id: 'mini', name: 'Mini' }, 'Worker B');

  usage.recordAssistantUsage('task1:a', {
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 7,
    cacheReadTokens: 60,
    cacheWriteTokens: 5,
    cost: 0.1,
  });
  usage.recordAssistantUsage('task1:b', {
    inputTokens: 50,
    outputTokens: 10,
    reasoningTokens: 3,
    cacheReadTokens: 20,
    cacheWriteTokens: 2,
    cost: 0.2,
  });
  usage.recordContext('task1:a', { currentTokens: 1200, tokenLimit: 200000, messagesLength: 17 });
  usage.recordContext('task1:a', { currentTokens: 1500, tokenLimit: 200000, messagesLength: 21 });
  usage.recordContext('task1:b', { currentTokens: 900, tokenLimit: 100000, messageCount: 12 });
  usage.recordCheckpoint('task1:a', { totalNanoAiu: 200_000_000 });
  usage.recordCheckpoint('task1:b', { totalNanoAiu: 300_000_000 });
  usage.recordTurn('task1:a', 1200);
  usage.recordTurn('task1:b', 800);

  const summary = usage.summary(3000);
  assert.equal(summary.inputTokens, 150);
  assert.equal(summary.outputTokens, 30);
  assert.equal(summary.reasoningTokens, 10);
  assert.equal(summary.cacheReadTokens, 80);
  assert.equal(summary.cacheWriteTokens, 7);
  assert.equal(summary.maxContextTokens, 1500);
  assert.equal(summary.maxContextMessages, 21);
  assert.equal(summary.aiCredits, 0.5);
  assert.equal(summary.turns, 2);
  assert.equal(summary.hasCreditData, true);
  assert.equal(summary.agents.length, 2);
  assert.equal(summary.agents[0].label, 'task1 · Worker A');
  assert.equal(summary.tasks.length, 1);
  assert.equal(summary.tasks[0].taskId, 'task1');
});

test('usage state survives a resume and new sessions add to request lifetime totals', () => {
  const first = new UsageTracker(1000);
  first.register('1-T1:reviewer', { sessionId: 'review-1' }, { id: 'terra', name: 'Terra' }, 'Strong reviewer');
  first.recordAssistantUsage('1-T1:reviewer', { inputTokens: 100, outputTokens: 10, reasoningTokens: 5 });
  first.recordCheckpoint('1-T1:reviewer', { totalNanoAiu: 250_000_000 });
  first.recordTurn('1-T1:reviewer', 500);

  const state = first.exportState();
  assert.equal(state.version, USAGE_STATE_VERSION);

  const resumed = new UsageTracker(9000);
  assert.equal(resumed.restore(state), true);
  resumed.register('1-T1:reviewer', { sessionId: 'review-2' }, { id: 'terra', name: 'Terra' }, 'Strong reviewer');
  resumed.recordAssistantUsage('1-T1:reviewer', { inputTokens: 40, outputTokens: 4, reasoningTokens: 2 });
  resumed.recordCheckpoint('1-T1:reviewer', { totalNanoAiu: 100_000_000 });
  resumed.recordTurn('1-T1:reviewer', 200);

  const summary = resumed.summary(9500);
  assert.equal(summary.inputTokens, 140);
  assert.equal(summary.outputTokens, 14);
  assert.equal(summary.reasoningTokens, 7);
  assert.equal(summary.aiCredits, 0.35);
  assert.equal(summary.turns, 2);
  assert.equal(summary.agents.length, 1);
  assert.equal(summary.agents[0].sessionId, 'review-2');
  assert.equal(summary.agents[0].label, '1-T1 · Strong reviewer');
  assert.equal(summary.run.inputTokens, 40);
  assert.equal(summary.run.outputTokens, 4);
  assert.equal(summary.run.aiCredits, 0.1);
  assert.equal(summary.tasks[0].inputTokens, 140);
});

test('usage delta isolates one review cycle from request-lifetime totals', () => {
  const delta = usageDelta(
    { inputTokens: 100, outputTokens: 10, reasoningTokens: 5, totalNanoAiu: 200_000_000, hasCreditData: true, elapsedMs: 1000 },
    { inputTokens: 140, outputTokens: 14, reasoningTokens: 8, totalNanoAiu: 260_000_000, hasCreditData: true, elapsedMs: 1300 },
  );
  assert.equal(delta.inputTokens, 40);
  assert.equal(delta.outputTokens, 4);
  assert.equal(delta.reasoningTokens, 3);
  assert.equal(delta.aiCredits, 0.06);
  assert.equal(delta.elapsedMs, 300);
});

test('task id is derived from persistent task-local usage keys', () => {
  assert.equal(taskIdFromAgent('2-T7:worker-a'), '2-T7');
  assert.equal(taskIdFromAgent('2-T7:reviewer'), '2-T7');
  assert.equal(taskIdFromAgent('coordinator'), null);
});