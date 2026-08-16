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

test('VS Code shows managed command start and bounded output progress without command text', () => {
  const { ui, progress, logs } = fixture();
  ui.agentManagedCommandProgress('Worker A', { phase: 'started', commandId: 'cmd-1', pid: 321 });
  ui.managedCommandProgressAt.set('cmd-1', 0);
  ui.agentManagedCommandProgress('Worker A', { phase: 'output', commandId: 'cmd-1', pid: 321, stream: 'stdout', bytes: 2048 });

  assert.match(progress[0], /managed command started.*PID 321/i);
  assert.match(progress[1], /managed command still running/i);
  assert.match(progress[1], /2\.0kB output observed/i);
  assert.doesNotMatch(progress.join('\n'), /secret-command/);
  assert.match(logs.join('\n'), /cmd-1/);
});


test('VS Code managed completion clears per-command progress state and reports outcome', () => {
  const { ui, progress, logs } = fixture();
  ui.agentManagedCommandProgress('Worker A', { phase: 'started', commandId: 'cmd-done', pid: 456 });
  assert.equal(ui.managedCommandBytes.has('cmd-done'), true);
  assert.equal(ui.managedCommandProgressAt.has('cmd-done'), true);

  ui.agentManagedCommandComplete('Worker A', {
    commandId: 'cmd-done', pid: 456, state: 'completed', exitCode: 7, elapsedMs: 1200,
  });

  assert.equal(ui.managedCommandBytes.has('cmd-done'), false);
  assert.equal(ui.managedCommandProgressAt.has('cmd-done'), false);
  assert.match(progress.at(-1), /managed command exit 7/i);
  assert.match(progress.at(-1), /PID 456/);
  assert.match(logs.at(-1), /id=cmd-done/);
});

test('VS Code managed completion surfaces unproven cancellation without command text', () => {
  const { ui, progress } = fixture();
  ui.agentManagedCommandComplete('Strong reviewer', {
    commandId: 'cmd-cancel', pid: 789, state: 'cancelled', elapsedMs: 3400, terminationProven: false,
  });
  assert.match(progress.at(-1), /cancelled.*termination unproven/i);
  assert.doesNotMatch(progress.at(-1), /secret-command/);
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
