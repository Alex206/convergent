'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelCallBudget } = require('../src/headless/runner');

function usage(agent, sessionId) {
  return { type: 'assistant_usage', agent, sessionId, data: {} };
}

function toolStart(agent, sessionId, id, tool) {
  return { type: 'tool_start', agent, sessionId, tool, data: { toolCallId: id, toolName: tool } };
}

function toolComplete(agent, sessionId, id, result) {
  return {
    type: 'tool_complete',
    agent,
    sessionId,
    data: { toolCallId: id, result: { content: JSON.stringify(result) } },
  };
}

test('historical #584 shape preserves a valid report_plan on call 9 without allowing call 10', () => {
  const breaches = [];
  const turnStops = [];
  const budget = createModelCallBudget({
    maxTotalCalls: 17,
    maxCallsPerTurn: 9,
    maxChatRequests: 100,
    onExceeded: (breach) => breaches.push(breach),
    onTurnLimit: (stop) => turnStops.push(stop),
  });
  const agent = 'Coordinator';
  const sessionId = 'coordinator-session';
  budget.handle({ type: 'prompt_send', agent, sessionId });

  // Calls 1-6 represent bounded repository inspection/tool continuations.
  for (let call = 1; call <= 6; call += 1) {
    budget.handle(usage(agent, sessionId));
    budget.handle(toolStart(agent, sessionId, `inspect-${call}`, 'view'));
    budget.handle(toolComplete(agent, sessionId, `inspect-${call}`, { ok: true }));
    budget.handle({ type: 'assistant_turn_end', agent, sessionId });
    budget.handle({ type: 'assistant_turn_start', agent, sessionId });
  }

  // Calls 7 and 8 submit malformed plans and are explicitly rejected by Convergent.
  for (let call = 7; call <= 8; call += 1) {
    budget.handle(usage(agent, sessionId));
    budget.handle(toolStart(agent, sessionId, `plan-${call}`, 'report_plan'));
    budget.handle(toolComplete(agent, sessionId, `plan-${call}`, { accepted: false, retry: true }));
    budget.handle({ type: 'assistant_turn_end', agent, sessionId });
    budget.handle({ type: 'assistant_turn_start', agent, sessionId });
  }

  // Call 9 is billed first, then selects a valid report_plan tool action.
  budget.handle(usage(agent, sessionId));
  assert.equal(breaches.length, 0, 'the ninth billed call must not be aborted before its tool action');
  budget.handle(toolStart(agent, sessionId, 'plan-9', 'report_plan'));
  budget.handle(toolComplete(agent, sessionId, 'plan-9', { accepted: true, taskCount: 1 }));

  assert.equal(breaches.length, 0, 'accepted report at the exact turn cap is a graceful per-session stop');
  assert.equal(turnStops.length, 1);
  assert.equal(turnStops[0].calls, 9);
  assert.equal(turnStops[0].toolName, 'report_plan');
  assert.equal(turnStops[0].boundary, 'accepted_report');
  assert.equal(budget.snapshot().totalCalls, 9);

  // A subsequent internal SDK continuation should be cancelled by the session-only
  // turn-stop callback, not converted into another billed model call or run breach.
  budget.handle({ type: 'assistant_turn_end', agent, sessionId });
  budget.handle({ type: 'assistant_turn_start', agent, sessionId });
  assert.equal(turnStops.length, 2);
  assert.equal(turnStops[1].boundary, 'post_report_turn_start');
  assert.equal(breaches.length, 0);

  // Once Convergent starts a new prompt, the per-turn budget is fresh.
  budget.handle({ type: 'prompt_send', agent: 'Worker A', sessionId: 'worker-a-session' });
  budget.handle(usage('Worker A', 'worker-a-session'));
  assert.equal(budget.snapshot().turnCalls['Worker A'], 1);
  assert.equal(budget.snapshot().totalCalls, 10);
});
