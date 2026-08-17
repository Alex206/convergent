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

test('raw tool commands stay in Output while chat receives aggregated activity', () => {
  const { ui, progress, logs } = fixture();
  ui.agentTool('Coordinator', 'powershell', 'git show secret-long-command --patch');
  assert.ok(logs.some((line) => line.includes('git show secret-long-command')));
  assert.equal(progress.some((line) => line.includes('secret-long-command')), false);
  assert.ok(progress.some((line) => /Coordinator: 1 tool activity/.test(line)));
});

test('usage progress is throttled in chat but always retained in Output', () => {
  const { ui, progress, logs } = fixture();
  const summary = { hasCreditData: true, aiCredits: 1, inputTokens: 1000, outputTokens: 100, turns: 1, elapsedMs: 1000 };
  ui.usageProgress(summary);
  ui.usageProgress({ ...summary, aiCredits: 2 });
  assert.equal(logs.filter((line) => line.includes('Usage:')).length, 2);
  assert.equal(progress.filter((line) => line.startsWith('Usage:')).length, 1);
});


test('task completion labels reflect the actual standard and high-risk topologies', () => {
  const standard = fixture();
  standard.ui.taskCompleted({ id: 'T1', title: 'Standard task' }, 'standard');
  assert.match(standard.markdown.join(''), /passed implementer \+ strong review/);
  assert.doesNotMatch(standard.markdown.join(''), /A\/B convergence/);

  const highRisk = fixture();
  highRisk.ui.taskCompleted({ id: 'T2', title: 'High-risk task' }, 'high_risk');
  assert.match(highRisk.markdown.join(''), /passed A\/B convergence and strong review/);
});

