'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { HeadlessWorkflowUi } = require('../src/headless/ui');
const { inspectModels } = require('../src/headless/model-preflight');
const {
  extractBenchmarkPrompt,
  defaultMaxModelCalls,
  defaultMaxModelCallsPerTurn,
  defaultMaxChatRequests,
  createModelCallBudget,
  parseArgs,
  createHeadlessPermissionHandler,
  createScriptedUserInputHandler,
  answersFromEnvironment,
} = require('../src/headless/runner');
const {
  resolveHeadlessRoleModels,
  assertHeadlessRoleModels,
} = require('../src/headless/model-policy');

test('benchmark prompt extraction uses only the Prompt fenced block', () => {
  const text = '# Scenario\n\n## Prompt\n\n```text\nImplement dependency ordering.\n```\n\n## Expected scope\nIgnore me.';
  assert.equal(extractBenchmarkPrompt(text), 'Implement dependency ordering.');
});

test('headless arguments require output outside target workspace and bound model calls/quota by flow', () => {
  const workspace = path.resolve('/tmp/target');
  assert.throws(() => parseArgs(['--workspace', workspace, '--prompt', 'x', '--output-dir', path.join(workspace, 'audit')]), /outside --workspace/);
  assert.throws(() => parseArgs(['--workspace', workspace, '--prompt-file', '/tmp/outside.md', '--output-dir', '/tmp/results']), /prompt-file must be inside/);
  const parsed = parseArgs(['--workspace', workspace, '--prompt', 'x', '--output-dir', '/tmp/results', '--flow', 'fast']);
  assert.equal(parsed.flow, 'fast');
  assert.equal(parsed.maxModelCalls, 24);
  assert.equal(parsed.maxModelCallsPerTurn, 10);
  assert.equal(parsed.maxChatRequests, 8);
  assert.equal(defaultMaxModelCalls('auto'), 60);
  assert.equal(defaultMaxModelCallsPerTurn('auto'), 20);
  assert.equal(defaultMaxChatRequests('auto'), 24);
  const overridden = parseArgs(['--workspace', workspace, '--prompt', 'x', '--output-dir', '/tmp/results', '--max-model-calls', '17', '--max-model-calls-per-turn', '6', '--max-chat-requests', '5']);
  assert.equal(overridden.maxModelCalls, 17);
  assert.equal(overridden.maxModelCallsPerTurn, 6);
  assert.equal(overridden.maxChatRequests, 5);
});

test('headless model-call budget aborts one runaway agent turn before the whole-run fuse', () => {
  const breaches = [];
  const budget = createModelCallBudget({ maxTotalCalls: 24, maxCallsPerTurn: 10, onExceeded: (breach) => breaches.push(breach) });
  budget.handle({ type: 'prompt_send', agent: 'Worker A' });
  for (let index = 0; index < 9; index += 1) budget.handle({ type: 'assistant_usage', agent: 'Worker A' });
  assert.equal(breaches.length, 0);
  budget.handle({ type: 'assistant_usage', agent: 'Worker A' });
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].kind, 'turn');
  assert.equal(breaches[0].agent, 'Worker A');
  assert.equal(breaches[0].calls, 10);
  assert.equal(budget.snapshot().totalCalls, 10);
});

test('headless model-call budget resets per-agent turn count but preserves total run count', () => {
  const breaches = [];
  const budget = createModelCallBudget({ maxTotalCalls: 5, maxCallsPerTurn: 4, onExceeded: (breach) => breaches.push(breach) });
  budget.handle({ type: 'prompt_send', agent: 'Worker A' });
  budget.handle({ type: 'assistant_usage', agent: 'Worker A' });
  budget.handle({ type: 'assistant_usage', agent: 'Worker A' });
  budget.handle({ type: 'prompt_send', agent: 'Worker A' });
  budget.handle({ type: 'assistant_usage', agent: 'Worker A' });
  budget.handle({ type: 'assistant_usage', agent: 'Worker A' });
  assert.equal(breaches.length, 0);
  budget.handle({ type: 'assistant_usage', agent: 'Worker B' });
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].kind, 'run');
  assert.equal(breaches[0].calls, 5);
});

test('headless budget protects the actual Copilot chat-request allowance delta', () => {
  const breaches = [];
  const budget = createModelCallBudget({ maxTotalCalls: 100, maxCallsPerTurn: 100, maxChatRequests: 3, onExceeded: (breach) => breaches.push(breach) });
  const usage = (usedRequests) => ({
    type: 'assistant_usage',
    agent: 'Worker A',
    data: { quotaSnapshots: { chat: { usedRequests } } },
  });
  budget.handle({ type: 'prompt_send', agent: 'Worker A' });
  budget.handle(usage(40));
  budget.handle(usage(41));
  budget.handle(usage(42));
  assert.equal(breaches.length, 0);
  budget.handle(usage(43));
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].kind, 'chat_requests');
  assert.equal(breaches[0].calls, 3);
  assert.equal(breaches[0].accountStartUsedRequests, 40);
  assert.equal(breaches[0].accountUsedRequests, 43);
  assert.equal(budget.snapshot().chatRequestsUsed, 3);
});

test('headless benchmark refuses silent auto fallback for required strong roles', () => {
  const available = [{ id: 'auto', name: 'Auto' }];
  const resolution = resolveHeadlessRoleModels({ coordinator: 'strong', reviewer: 'strong' }, available);
  assert.equal(resolution.coordinator.id, 'auto');
  assert.equal(resolution.reviewer.id, 'auto');
  assert.equal(resolution.issues.length, 2);
  assert.throws(
    () => assertHeadlessRoleModels(resolution),
    (error) => error.code === 'CONVERGENT_HEADLESS_MODEL_POLICY' && /degraded to Copilot auto/i.test(error.message),
  );

  const intentionalAuto = resolveHeadlessRoleModels({ coordinator: 'auto', reviewer: 'auto' }, available);
  assert.equal(intentionalAuto.issues.length, 0);
  assert.doesNotThrow(() => assertHeadlessRoleModels(intentionalAuto));
});

test('headless strong role preflight resolves an available strong model explicitly', () => {
  const available = [
    { id: 'gpt-5-mini', name: 'GPT-5 mini' },
    { id: 'gpt-5.4', name: 'GPT-5.4', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  ];
  const resolution = resolveHeadlessRoleModels({ coordinator: 'strong', reviewer: 'strong' }, available);
  assert.equal(resolution.issues.length, 0);
  assert.equal(resolution.coordinator.id, 'gpt-5.4');
  assert.equal(resolution.reviewer.id, 'gpt-5.4');
});

test('models-only preflight only lists models and does not create an agent session', async () => {
  let listCalls = 0;
  let createSessionCalls = 0;
  const client = {
    async listModels() {
      listCalls += 1;
      return [{ id: 'auto', name: 'Auto' }];
    },
    async createSession() {
      createSessionCalls += 1;
      throw new Error('model preflight must never create a session');
    },
  };
  const report = await inspectModels({ coordinator: 'strong', reviewer: 'strong' }, { sdk: {}, client });
  assert.equal(listCalls, 1);
  assert.equal(createSessionCalls, 0);
  assert.equal(report.sendsAgentPrompts, false);
  assert.equal(report.issues.length, 2);
});

test('headless permissions allow workspace work but deny risky shell and outside writes', async () => {
  const handler = createHeadlessPermissionHandler('/tmp/work', { logger: { error() {} } });
  assert.equal((await handler({ kind: 'read' })).kind, 'approve-once');
  assert.equal((await handler({ kind: 'write', path: '/tmp/work/a.txt' })).kind, 'approve-once');
  assert.equal((await handler({ kind: 'write', path: '/tmp/other/a.txt' })).kind, 'deny');
  assert.equal((await handler({ kind: 'shell', fullCommandText: 'python -B -m unittest' })).kind, 'approve-once');
  assert.equal((await handler({ kind: 'shell', fullCommandText: 'git reset --hard HEAD~1' })).kind, 'deny');
});

test('scripted input fails closed when an unexpected interactive question appears', async () => {
  const handler = createScriptedUserInputHandler([], { log() {} });
  await assert.rejects(() => handler({ question: 'Which behavior?' }), (error) => error.code === 'CONVERGENT_HEADLESS_INPUT_REQUIRED');
});

test('answers JSON is validated as an array', () => {
  assert.deepEqual(answersFromEnvironment({ CONVERGENT_HEADLESS_ANSWERS_JSON: '["yes", "no"]' }), ['yes', 'no']);
  assert.throws(() => answersFromEnvironment({ CONVERGENT_HEADLESS_ANSWERS_JSON: '{"x":1}' }), /JSON array/);
});

test('headless UI emits audit-compatible worker/reviewer events and aborts stalls', async () => {
  const events = [];
  const ui = new HeadlessWorkflowUi({ eventSink: (event) => events.push(event), logger: { log() {} } });
  ui.passResult('B', { verdict: 'clean', summary: 'ok', findings: [], checks: [] }, false, 'abcdef1234567890', { durationMs: 5 });
  ui.reviewResult({ verdict: 'clean', summary: 'review ok', findings: [], checks: [] }, 1, { durationMs: 6 });
  assert.equal(events.some((event) => event.type === 'worker_pass_result'), true);
  assert.equal(events.some((event) => event.type === 'strong_review_result'), true);
  assert.deepEqual(await ui.agentToolStallDecision(), { action: 'abort' });
  assert.deepEqual(await ui.agentInactivityDecision(), { action: 'abort' });
});
