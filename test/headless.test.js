'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { HeadlessWorkflowUi } = require('../src/headless/ui');
const { extractBenchmarkPrompt, defaultMaxModelCalls, parseArgs, createHeadlessPermissionHandler, createScriptedUserInputHandler, answersFromEnvironment } = require('../src/headless/runner');

test('benchmark prompt extraction uses only the Prompt fenced block', () => {
  const text = '# Scenario\n\n## Prompt\n\n```text\nImplement dependency ordering.\n```\n\n## Expected scope\nIgnore me.';
  assert.equal(extractBenchmarkPrompt(text), 'Implement dependency ordering.');
});

test('headless arguments require output outside target workspace and bound model calls by flow', () => {
  const workspace = path.resolve('/tmp/target');
  assert.throws(() => parseArgs(['--workspace', workspace, '--prompt', 'x', '--output-dir', path.join(workspace, 'audit')]), /outside --workspace/);
  assert.throws(() => parseArgs(['--workspace', workspace, '--prompt-file', '/tmp/outside.md', '--output-dir', '/tmp/results']), /prompt-file must be inside/);
  const parsed = parseArgs(['--workspace', workspace, '--prompt', 'x', '--output-dir', '/tmp/results', '--flow', 'fast']);
  assert.equal(parsed.flow, 'fast');
  assert.equal(parsed.maxModelCalls, 24);
  assert.equal(defaultMaxModelCalls('auto'), 60);
  assert.equal(defaultMaxModelCalls('thorough'), 120);
  const explicit = parseArgs(['--workspace', workspace, '--prompt', 'x', '--output-dir', '/tmp/results', '--flow', 'fast', '--max-model-calls', '17']);
  assert.equal(explicit.maxModelCalls, 17);
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