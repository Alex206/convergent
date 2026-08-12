'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeEfficiency } = require('../src/headless/efficiency-summary');

test('efficiency summary exposes prompt amplification, auto leakage, quota delta and report fallback', () => {
  const events = [
    { type: 'session_create', agent: 'Worker A', model: 'auto' },
    { type: 'prompt_send', agent: 'Worker A' },
    ...Array.from({ length: 11 }, (_, index) => ({
      type: 'assistant_usage',
      agent: 'Worker A',
      data: {
        model: index % 2 ? 'claude-haiku-4.5' : 'gpt-5-mini',
        quotaSnapshots: { chat: { usedRequests: 40 + index } },
      },
    })),
    { type: 'tool_start', agent: 'Worker A' },
    { type: 'agent_report_recovered', agent: 'Worker A' },
    { type: 'task_start' },
  ];

  const summary = analyzeEfficiency(events);
  assert.equal(summary.promptSends, 1);
  assert.equal(summary.modelCalls, 11);
  assert.equal(summary.modelCallsPerPrompt, 11);
  assert.equal(summary.chatQuota.deltaUsedRequests, 10);
  assert.deepEqual(summary.autoSessionAgents, ['Worker A']);
  assert.equal(summary.reportRecoveries, 1);
  assert.equal(summary.agents['Worker A'].maxModelCallsPerPrompt, 11);
  assert.ok(summary.warnings.some((warning) => warning.kind === 'auto_session_model'));
  assert.ok(summary.warnings.some((warning) => warning.kind === 'model_call_amplification'));
  assert.ok(summary.warnings.some((warning) => warning.kind === 'runaway_agent_turn'));
  assert.ok(summary.warnings.some((warning) => warning.kind === 'serialized_report_recovery'));
});

test('efficiency summary keeps separate prompt turns for one persistent agent', () => {
  const events = [
    { type: 'prompt_send', agent: 'Reviewer' },
    { type: 'assistant_usage', agent: 'Reviewer', data: { model: 'gpt-5.4' } },
    { type: 'assistant_usage', agent: 'Reviewer', data: { model: 'gpt-5.4' } },
    { type: 'prompt_send', agent: 'Reviewer' },
    { type: 'assistant_usage', agent: 'Reviewer', data: { model: 'gpt-5.4' } },
  ];
  const summary = analyzeEfficiency(events);
  assert.equal(summary.agents.Reviewer.promptSends, 2);
  assert.equal(summary.agents.Reviewer.modelCalls, 3);
  assert.equal(summary.agents.Reviewer.maxModelCallsPerPrompt, 2);
  assert.equal(summary.agents.Reviewer.turns.length, 2);
});
