'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { VscodeWorkflowUi, detailedUsageMarkdown } = require('../src/ui/vscode-ui-0.5');

function fixture() {
  const markdown = [];
  const logs = [];
  const events = [];
  const ui = new VscodeWorkflowUi(
    { Uri: { file: (fsPath) => ({ fsPath }) }, window: {} },
    { markdown: (value) => markdown.push(String(value)), progress() {}, anchor() {} },
    { appendLine: (value) => logs.push(String(value)) },
    { workspace: path.resolve('/repo'), eventSink: (event) => events.push(event) },
  );
  return { ui, markdown, logs, events };
}

function summary() {
  return {
    elapsedMs: 1500,
    hasCreditData: true,
    aiCredits: 1.75,
    inputTokens: 230,
    outputTokens: 33,
    reasoningTokens: 12,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    maxContextTokens: 100,
    maxContextMessages: 5,
    turns: 3,
    calls: 4,
    agents: [{
      agent: '1-T1:reviewer-adversarial-security',
      label: '1-T1 · Adversarial & security reviewer',
      model: 'GPT-5.6 Luna',
      aiCredits: 0.25,
      hasCreditData: true,
      inputTokens: 80,
      outputTokens: 8,
      reasoningTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      maxContextTokens: 100,
      maxContextMessages: 5,
      turns: 1,
      calls: 1,
      durationMs: 200,
    }],
    tasks: [{
      taskId: '1-T1',
      hasCreditData: true,
      aiCredits: 0.25,
      inputTokens: 80,
      outputTokens: 8,
      reasoningTokens: 2,
      calls: 1,
      turns: 1,
    }],
    run: {
      elapsedMs: 500,
      hasCreditData: true,
      aiCredits: 0.75,
      inputTokens: 130,
      outputTokens: 13,
      turns: 2,
    },
  };
}

test('0.5 detailed usage shows request lifetime, current execution, task, and task-qualified reviewer', () => {
  const text = detailedUsageMarkdown(summary());
  assert.match(text, /Request lifetime/);
  assert.match(text, /Current execution/);
  assert.match(text, /Per-task totals/);
  assert.match(text, /1-T1/);
  assert.match(text, /1-T1 · Adversarial & security reviewer/);
});

test('0.5 review result visibly reports per-cycle usage and reviewer tool count', () => {
  const { ui, markdown, events } = fixture();
  ui.reviewResult({ verdict: 'clean', findings: [], checks: [], summary: 'clean' }, 2, {
    durationMs: 1000,
    usage: summary(),
    cycleUsage: {
      elapsedMs: 1000,
      hasCreditData: true,
      aiCredits: 0.125,
      inputTokens: 50,
      outputTokens: 5,
      turns: 1,
    },
    tools: [
      { toolName: 'batch_view', detail: 'src/a.js' },
      { toolName: 'run_command', detail: 'npm test' },
    ],
  });
  const text = markdown.join('');
  assert.match(text, /Cycle 2 usage/);
  assert.match(text, /2 reviewer tool call/);
  assert.equal(events.at(-1).type, 'strong_review_cycle_usage');
});