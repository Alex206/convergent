'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createModelCallBudget } = require('../src/headless/runner');

function usage(agent, sessionId) {
  return { type: 'assistant_usage', agent, sessionId, data: {} };
}

function toolStart(agent, sessionId, toolCallId, tool) {
  return { type: 'tool_start', agent, sessionId, tool, data: { toolCallId } };
}

function toolComplete(agent, sessionId, toolCallId, result) {
  return {
    type: 'tool_complete',
    agent,
    sessionId,
    data: {
      toolCallId,
      result: { content: JSON.stringify(result) },
    },
  };
}

test('accepted structured report remains graceful when usage for the capped call arrives after tool completion', () => {
  const breaches = [];
  const turnStops = [];
  const budget = createModelCallBudget({
    maxTotalCalls: 24,
    maxCallsPerTurn: 10,
    onExceeded: (breach) => breaches.push(breach),
    onTurnLimit: (stop) => turnStops.push(stop),
  });
  const sessionId = 'worker-a-session';

  budget.handle({ type: 'prompt_send', agent: 'Worker A', sessionId });
  for (let index = 0; index < 9; index += 1) budget.handle(usage('Worker A', sessionId));

  budget.handle(toolStart('Worker A', sessionId, 'report-10', 'report_pass'));
  budget.handle(toolComplete('Worker A', sessionId, 'report-10', { accepted: true, verdict: 'changed' }));
  assert.equal(turnStops.length, 0, 'the tenth usage event has not arrived yet');

  budget.handle(usage('Worker A', sessionId));
  assert.equal(breaches.length, 0);
  assert.equal(turnStops.length, 1);
  assert.equal(turnStops[0].kind, 'turn');
  assert.equal(turnStops[0].calls, 10);
  assert.equal(turnStops[0].toolName, 'report_pass');
  assert.equal(turnStops[0].boundary, 'accepted_report_usage');

  budget.handle({ type: 'assistant_turn_end', agent: 'Worker A', sessionId });
  assert.equal(breaches.length, 0, 'late usage for an accepted report must not fail the whole headless run');
  assert.deepEqual(budget.snapshot().pendingTurnLimits, {});

  budget.handle({ type: 'prompt_send', agent: 'Strong reviewer', sessionId: 'reviewer-session' });
  budget.handle(usage('Strong reviewer', 'reviewer-session'));
  assert.equal(breaches.length, 0, 'the next agent receives a fresh per-turn budget');
});
