'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { captureWorkspaceBaseline, formatWorkspaceBaseline, MAX_PROMPT_ENTRIES } = require('../src/orchestrator/workspace-baseline');

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

test('task workspace baseline records pre-existing dirty and untracked state without treating it as task output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-baseline-'));
  try {
    await git(root, 'init');
    await git(root, 'config', 'user.email', 'test@example.invalid');
    await git(root, 'config', 'user.name', 'Convergent Test');
    await fs.writeFile(path.join(root, 'README.md'), 'initial\n', 'utf8');
    await git(root, 'add', 'README.md');
    await git(root, 'commit', '-m', 'initial');

    await fs.mkdir(path.join(root, '.vscode'));
    await fs.writeFile(path.join(root, '.vscode', 'settings.json'), '{"editor.formatOnSave":true}\n', 'utf8');
    await fs.writeFile(path.join(root, 'README.md'), 'changed by user before task\n', 'utf8');

    const baseline = await captureWorkspaceBaseline(root);
    assert.equal(baseline.clean, false);
    assert.equal(baseline.count, 2);
    assert.ok(baseline.entries.some((entry) => entry.includes('README.md')));
    assert.ok(baseline.entries.some((entry) => entry.includes('.vscode/settings.json')));
    assert.match(baseline.sha256, /^[0-9a-f]{64}$/);

    const prompt = formatWorkspaceBaseline(baseline);
    assert.match(prompt, /user-owned pre-existing state/i);
    assert.match(prompt, /\.vscode\/settings\.json/);
    assert.match(prompt, /do not report, remove, revert, overwrite, or stage/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace baseline prompt is bounded for very dirty worktrees', () => {
  const entries = Array.from({ length: MAX_PROMPT_ENTRIES + 7 }, (_, index) => `?? generated-${index}.txt`);
  const prompt = formatWorkspaceBaseline({ clean: false, count: entries.length, entries, sha256: 'x' });
  assert.match(prompt, /7 additional pre-existing status entries omitted/i);
  assert.equal(prompt.includes(`generated-${MAX_PROMPT_ENTRIES + 6}.txt`), false);
});

test('clean task baseline is explicit and compact', () => {
  const prompt = formatWorkspaceBaseline({ clean: true, count: 0, entries: [], sha256: 'x' });
  assert.match(prompt, /clean Git worktree/i);
  assert.ok(prompt.length < 250);
});