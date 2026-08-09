'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  captureWorkspaceChangeState,
  buildTaskChangeManifest,
  formatTaskChangeManifest,
} = require('../src/orchestrator/task-change-manifest');

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-manifest-'));
  await git(root, 'init');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'config', 'user.name', 'Convergent Test');
  await fs.writeFile(path.join(root, 'app.js'), 'module.exports = 1;\n', 'utf8');
  await fs.writeFile(path.join(root, 'README.md'), 'initial\n', 'utf8');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');
  return root;
}

test('task change manifest excludes untouched pre-existing dirty/untracked state and names new task paths', async () => {
  const root = await makeRepo();
  try {
    await fs.mkdir(path.join(root, '.vscode'));
    await fs.writeFile(path.join(root, '.vscode', 'settings.json'), '{"editor.formatOnSave":true}\n', 'utf8');
    await fs.writeFile(path.join(root, 'README.md'), 'user change before task\n', 'utf8');
    const baseline = await captureWorkspaceChangeState(root);

    await fs.writeFile(path.join(root, 'app.js'), 'module.exports = 2;\n', 'utf8');
    await fs.writeFile(path.join(root, 'new-test.js'), 'test\n', 'utf8');
    const current = await captureWorkspaceChangeState(root, baseline.head);
    const manifest = buildTaskChangeManifest(baseline, current);

    assert.deepEqual(manifest.entries.map((entry) => entry.path), ['app.js', 'new-test.js']);
    assert.equal(manifest.entries.some((entry) => entry.path === 'README.md'), false);
    assert.equal(manifest.entries.some((entry) => entry.path === '.vscode/settings.json'), false);
    const text = formatTaskChangeManifest(manifest);
    assert.match(text, /app\.js/);
    assert.match(text, /new-test\.js/);
    assert.match(text, /unchanged pre-existing/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('task change manifest detects further modification of a pre-existing path', async () => {
  const root = await makeRepo();
  try {
    await fs.writeFile(path.join(root, 'README.md'), 'user change before task\n', 'utf8');
    const baseline = await captureWorkspaceChangeState(root);

    await fs.writeFile(path.join(root, 'README.md'), 'task changed the already-dirty file\n', 'utf8');
    const current = await captureWorkspaceChangeState(root, baseline.head);
    const manifest = buildTaskChangeManifest(baseline, current);

    assert.equal(manifest.count, 1);
    assert.equal(manifest.entries[0].path, 'README.md');
    assert.equal(manifest.entries[0].kind, 'preexisting_state_changed');
    assert.match(formatTaskChangeManifest(manifest), /pre-existing path changed since task start/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('task change manifest retains exact changed-file hints after a task-local commit moves HEAD', async () => {
  const root = await makeRepo();
  try {
    const baseline = await captureWorkspaceChangeState(root);
    await fs.writeFile(path.join(root, 'app.js'), 'module.exports = 3;\n', 'utf8');
    await git(root, 'add', 'app.js');
    await git(root, 'commit', '-m', 'task change');

    const current = await captureWorkspaceChangeState(root, baseline.head);
    const manifest = buildTaskChangeManifest(baseline, current);
    assert.equal(manifest.count, 1);
    assert.equal(manifest.entries[0].path, 'app.js');
    assert.notEqual(manifest.currentHead, baseline.head);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
