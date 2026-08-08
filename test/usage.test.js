'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { UsageTracker, aiCreditsFromNanoAiu } = require('../src/orchestrator/usage');

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
});
