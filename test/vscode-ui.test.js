'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { VscodeWorkflowUi, diagnosticsMarkdown } = require('../src/ui/vscode-ui');

function fixture() {
  const markdown = [];
  const progress = [];
  const anchors = [];
  const buttons = [];
  const logs = [];
  const events = [];
  const stream = {
    markdown(value) { markdown.push(String(value)); },
    progress(value) { progress.push(String(value)); },
    button(value) { buttons.push(value); },
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
  return { ui, markdown, progress, anchors, buttons, logs, events };
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

test('diagnostics heading can identify the installed Convergent version', () => {
  const text = diagnosticsMarkdown([], { version: '0.2.0-dev.10' });
  assert.match(text, /Convergent 0\.2\.0-dev\.10 diagnostics/);
});


test('timeout decisions are rendered as chat buttons and resolve without a modal', async () => {
  const { ui, markdown, buttons } = fixture();
  const pending = ui.agentInactivityDecision('Worker A', { lastActivityAgoMs: 120_000 });
  assert.match(markdown.join(''), /Worker A: no activity/);
  assert.deepEqual(buttons.map((button) => button.title), ['Continue 5 min', 'Abort agent turn']);
  const [id, choice] = buttons[0].arguments;
  assert.equal(ui.resolveChatDecision(id, choice), true);
  assert.deepEqual(await pending, { action: 'continue', waitMs: 5 * 60_000 });
});

test('managed tool stall offers recovery as a chat decision', async () => {
  const { ui, buttons } = fixture();
  const pending = ui.agentToolStallDecision('Worker A', {
    currentTool: { name: 'run_command', detail: 'npm test', quietMs: 120_000, elapsedMs: 130_000 },
  });
  assert.deepEqual(buttons.map((button) => button.title), ['Continue 5 min', 'Continue 15 min', 'Terminate command & recover']);
  const recovery = buttons.at(-1);
  assert.equal(ui.resolveChatDecision(...recovery.arguments), true);
  assert.deepEqual(await pending, { action: 'abort' });
});
