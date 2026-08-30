'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { VscodeWorkflowUi, detailedUsageMarkdown, diagnosticsMarkdown } = require('../src/ui/vscode-ui');

function fixture() {
  const markdown = [];
  const progress = [];
  const anchors = [];
  const logs = [];
  const events = [];
  const stream = {
    markdown(value) { markdown.push(String(value)); },
    progress(value) { progress.push(String(value)); },
    anchor(uri, title) { anchors.push({ uri, title }); },
  };
  const vscode = {
    Uri: { file: (fsPath) => ({ fsPath }) },
    window: { showWarningMessage: async () => undefined },
  };
  const output = { appendLine(value) { logs.push(String(value)); } };
  const ui = new VscodeWorkflowUi(vscode, stream, output, {
    workspace: path.resolve('/repo'),
    version: '0.2.0-dev.10',
    flowMode: 'fast',
    eventSink: (event) => events.push(event),
  });
  return { ui, markdown, progress, anchors, logs, events };
}

test('run header exposes exact Convergent version and flow through the generic event sink', () => {
  const { ui, markdown, logs, events } = fixture();
  ui.runStarted({ flowLabel: 'Fast' });

  assert.match(markdown.join(''), /Convergent 0\.2\.0-dev\.10/);
  assert.match(markdown.join(''), /Fast/);
  assert.ok(logs.some((line) => line.includes('0.2.0-dev.10')));
  assert.deepEqual(events[0], {
    type: 'ui_run_started',
    convergentVersion: '0.2.0-dev.10',
    flowMode: 'fast',
    flowLabel: 'Fast',
  });
});

test('review findings use stable native chat anchors for workspace files', () => {
  const { ui, anchors, events } = fixture();
  ui.reviewResult({
    verdict: 'findings',
    summary: 'one issue',
    findings: [{ severity: 'medium', title: 'Fix parser', description: 'broken', file: 'taskflow/config.py' }],
    checks: [],
  }, 1);

  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].title, 'taskflow/config.py');
  assert.equal(anchors[0].uri.fsPath, path.join(path.resolve('/repo'), 'taskflow/config.py'));
  assert.equal(events.at(-1).type, 'strong_review_result');
});

test('review result exposes review-cycle usage and tool count', () => {
  const { ui, markdown, events } = fixture();
  ui.reviewResult({ verdict: 'clean', summary: 'accepted', findings: [], checks: [] }, 3, {
    durationMs: 1500,
    usage: { inputTokens: 5000, outputTokens: 500, turns: 4, elapsedMs: 9000, hasCreditData: true, aiCredits: 0.5 },
    cycleUsage: { inputTokens: 1200, outputTokens: 80, reasoningTokens: 250, turns: 1, elapsedMs: 1500, hasCreditData: true, aiCredits: 0.12 },
    tools: [{ toolName: 'builtin:bash' }, { toolName: 'custom:report_review' }],
  });

  assert.match(markdown.join(''), /R3 usage:/);
  assert.match(markdown.join(''), /2 tool call\(s\)/);
  assert.equal(events.at(-1).cycleUsage.inputTokens, 1200);
  assert.equal(events.at(-1).tools.length, 2);
});

test('detailed usage distinguishes request lifetime current execution and task totals', () => {
  const text = detailedUsageMarkdown({
    inputTokens: 1400,
    outputTokens: 140,
    reasoningTokens: 300,
    cacheReadTokens: 200,
    cacheWriteTokens: 20,
    maxContextTokens: 1000,
    maxContextMessages: 10,
    turns: 5,
    elapsedMs: 20000,
    hasCreditData: true,
    aiCredits: 0.7,
    run: { inputTokens: 400, outputTokens: 40, turns: 2, elapsedMs: 4000, hasCreditData: true, aiCredits: 0.2 },
    tasks: [{ taskId: '1-T1', inputTokens: 1000, outputTokens: 100, reasoningTokens: 250, calls: 3, turns: 3, hasCreditData: true, aiCredits: 0.5 }],
    agents: [{ label: '1-T1 · Strong reviewer', model: 'Terra', inputTokens: 1000, outputTokens: 100, reasoningTokens: 250, calls: 3, turns: 3, hasCreditData: true, aiCredits: 0.5 }],
  });

  assert.match(text, /Request lifetime/);
  assert.match(text, /Current execution/);
  assert.match(text, /Per-task totals/);
  assert.match(text, /1-T1/);
  assert.match(text, /1-T1 · Strong reviewer/);
});

test('diagnostics heading can identify the installed Convergent version', () => {
  const text = diagnosticsMarkdown([], { version: '0.2.0-dev.10' });
  assert.match(text, /Convergent 0\.2\.0-dev\.10 diagnostics/);
});