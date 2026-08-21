'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VscodeWorkflowUi } = require('../src/ui/vscode-ui');

function fixture(choice = 'Terminate command & recover') {
  const progress = [];
  const markdown = [];
  const logs = [];
  const warnings = [];
  const stream = {
    progress: (value) => progress.push(value),
    markdown: (value) => markdown.push(value),
  };
  const output = { appendLine: (value) => logs.push(value) };
  const vscode = {
    window: {
      showWarningMessage: async (message, options, ...choices) => {
        warnings.push({ message, options, choices });
        return choice;
      },
    },
    Uri: { file: (value) => value },
  };
  return { ui: new VscodeWorkflowUi(vscode, stream, output, { workspace: '/repo' }), progress, markdown, logs, warnings };
}

test('VS Code shows a sanitized managed command while it runs plus bounded output progress', () => {
  const { ui, progress, logs } = fixture();
  ui.agentManagedCommandProgress('Worker A', { phase: 'started', commandId: 'cmd-1', pid: 321, displayCommand: 'pytest -q tests', shellLanguage: 'powershell' });
  ui.managedCommandProgressAt.set('cmd-1', 0);
  ui.agentManagedCommandProgress('Worker A', { phase: 'output', commandId: 'cmd-1', pid: 321, stream: 'stdout', bytes: 2048 });

  assert.match(progress[0], /running command.*pytest -q tests.*PID 321/i);
  assert.match(progress[1], /managed command still running/i);
  assert.match(progress[1], /2\.0kB output observed/i);
  assert.match(logs.join('\n'), /cmd-1/);
});


test('VS Code managed completion clears state and renders command metadata without stdout/stderr in chat', () => {
  const { ui, markdown, logs } = fixture();
  ui.agentManagedCommandProgress('Worker A', { phase: 'started', commandId: 'cmd-done', pid: 456, displayCommand: 'pytest -q' });
  assert.equal(ui.managedCommandBytes.has('cmd-done'), true);
  assert.equal(ui.managedCommandProgressAt.has('cmd-done'), true);

  ui.agentManagedCommandComplete('Worker A', {
    commandId: 'cmd-done', pid: 456, state: 'completed', exitCode: 7, elapsedMs: 1200,
    displayCommand: 'pytest -q', shellLanguage: 'powershell', stderr: '', stdout: '',
  });

  assert.equal(ui.managedCommandBytes.has('cmd-done'), false);
  assert.equal(ui.managedCommandProgressAt.has('cmd-done'), false);
  assert.match(markdown.join('\n'), /Worker A ran command.*exit 7/i);
  assert.match(markdown.join('\n'), /pytest -q/);
  assert.doesNotMatch(markdown.join('\n'), /stdout|stderr|Show command output/i);
  assert.match(logs.at(-1), /id=cmd-done/);
});

test('VS Code managed completion surfaces unproven cancellation as a command result', () => {
  const { ui, markdown } = fixture();
  ui.agentManagedCommandComplete('Strong reviewer', {
    commandId: 'cmd-cancel', pid: 789, state: 'cancelled', elapsedMs: 3400, terminationProven: false,
    displayCommand: 'pytest -q', stderr: '',
  });
  assert.match(markdown.join('\n'), /cancelled.*termination unproven/i);
  assert.match(markdown.join('\n'), /pytest -q/);
});

test('VS Code stall decision explains managed tree termination and recovery semantics', async () => {
  const { ui, warnings } = fixture();
  const decision = await ui.agentToolStallDecision('Worker A', {
    currentTool: { name: 'run_command', detail: 'python tests.py', quietMs: 12_000, elapsedMs: 20_000 },
  });

  assert.deepEqual(decision, { action: 'abort' });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].choices.includes('Terminate command & recover'));
  assert.match(warnings[0].message, /kills the managed process tree first/i);
  assert.match(warnings[0].message, /termination is proven/i);
});

test('VS Code stalled message distinguishes proven and unproven managed termination', () => {
  const proven = fixture();
  proven.ui.agentToolStalled('Worker A', 'run_command', 5000, {
    managedCommandTermination: { active: true, proven: true, commandId: 'cmd-1', pid: 123 },
  });
  assert.match(proven.markdown.join('\n'), /termination was proven/i);
  assert.match(proven.markdown.join('\n'), /fresh agent session/i);

  const unproven = fixture();
  unproven.ui.agentToolStalled('Worker A', 'run_command', 5000, {
    managedCommandTermination: { active: true, proven: false, commandId: 'cmd-2', pid: 124 },
  });
  assert.match(unproven.markdown.join('\n'), /could not be proven/i);
  assert.match(unproven.markdown.join('\n'), /will not auto-retry/i);
});


test('successful command card contains command/status only when output is retained elsewhere', () => {
  const { ui, markdown } = fixture();
  ui.agentManagedCommandComplete('Worker A', {
    commandId: 'cmd-success', pid: 100, state: 'completed', exitCode: 0, elapsedMs: 2200,
    displayCommand: 'node --test', shellLanguage: 'powershell', stdout: '', stderr: '', stdoutTruncated: false,
  });
  const text = markdown.join('\n');
  assert.match(text, /✓.*Worker A ran command.*exit 0/i);
  assert.match(text, /node --test/);
  assert.doesNotMatch(text, /Output preview truncated|Show command output/i);
});


test('managed command completion does not emit a duplicate generic tool progress line', () => {
  const { ui, progress } = fixture();
  ui.agentToolComplete('Worker A', 'run_command', 12_000, false);
  assert.equal(progress.length, 0);
  ui.agentToolComplete('Worker A', 'powershell', 12_000, false);
  assert.equal(progress.length, 1);
});
