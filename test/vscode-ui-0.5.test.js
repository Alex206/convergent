'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { VscodeWorkflowUi, detailedUsageMarkdown } = require('../src/ui/vscode-ui-0.5');

function fixture({ showInputBox = async () => undefined } = {}) {
  const markdown = [];
  const logs = [];
  const events = [];
  const buttons = [];
  const ui = new VscodeWorkflowUi(
    {
      Uri: { file: (fsPath) => ({ fsPath }) },
      window: {
        showInputBox,
        showWarningMessage: async () => undefined,
      },
    },
    {
      markdown: (value) => markdown.push(String(value)),
      progress() {},
      anchor() {},
      button: (value) => buttons.push(value),
    },
    { appendLine: (value) => logs.push(String(value)) },
    { workspace: path.resolve('/repo'), eventSink: (event) => events.push(event) },
  );
  return { ui, markdown, logs, events, buttons };
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
  assert.match(text, /current-execution delta/);
  assert.match(text, /2 reviewer tool call/);
  assert.equal(events.at(-1).type, 'strong_review_cycle_usage');
  assert.equal(events.at(-1).scope, 'current_execution_delta');
});

test('0.5 suppresses generic run_command tool success because managed exit state is authoritative', () => {
  const { ui, logs } = fixture();
  ui.agentToolComplete('Worker A', 'run_command', 1200, true);
  assert.deepEqual(logs, []);

  ui.agentToolComplete('Worker A', 'batch_view', 1200, true);
  assert.match(logs.join('\n'), /batch_view.*success/);
});

test('stalled tool keeps running while stop decision is open and completion retires that decision', async () => {
  const { ui, buttons, logs, events } = fixture();
  const pending = ui.agentToolStallDecision('Worker A', {
    currentTool: {
      name: 'run_command',
      detail: 'npm test',
      toolCallId: 'tool-17',
      quietMs: 120_000,
      elapsedMs: 130_000,
    },
  });

  assert.equal(ui.pendingChatDecisions.size, 1);
  assert.deepEqual(buttons.map((button) => button.title), [
    'Continue 5 min',
    'Continue 15 min',
    'Terminate command & recover',
  ]);

  ui.agentToolComplete('Worker A', 'run_command', 131_000, true);
  assert.equal(ui.pendingChatDecisions.size, 0);
  assert.deepEqual(await pending, { action: 'completed' });
  assert.ok(logs.some((line) => /retired decision/.test(line)));
  assert.equal(events.at(-1).type, 'tool_stall_decision_retired');
});

test('AI-credit budget asks for a new total ceiling and returns the exact delta needed by the engine', async () => {
  let inputOptions;
  const { ui, markdown } = fixture({
    showInputBox: async (options) => {
      inputOptions = options;
      return '200';
    },
  });

  const decision = await ui.limitDecision('ai_credits', {
    current: 125,
    limit: 100,
    increment: 100,
  });

  assert.match(markdown.join(''), /AI-credit budget reached/);
  assert.match(inputOptions.prompt, /new total AI-credit limit/i);
  assert.deepEqual(decision, {
    action: 'continue',
    additional: 75,
    newLimit: 200,
  });
});

test('AI-credit budget input supports unlimited and cancel-to-pause', async () => {
  const unlimited = fixture({ showInputBox: async () => 'unlimited' });
  assert.deepEqual(
    await unlimited.ui.limitDecision('ai_credits', { current: 10, limit: 10, increment: 10 }),
    { action: 'unlimited' },
  );

  const paused = fixture({ showInputBox: async () => undefined });
  assert.deepEqual(
    await paused.ui.limitDecision('ai_credits', { current: 10, limit: 10, increment: 10 }),
    { action: 'pause' },
  );
});
