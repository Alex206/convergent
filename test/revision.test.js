'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { workspaceRevision } = require('../src/orchestrator/revision');

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

test('revision fingerprint changes for tracked and untracked content', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-revision-'));
  try {
    await git(dir, 'init');
    await git(dir, 'config', 'user.email', 'test@example.com');
    await git(dir, 'config', 'user.name', 'Convergent Test');
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'one\n');
    await git(dir, 'add', 'tracked.txt');
    await git(dir, 'commit', '-m', 'initial');

    const clean = await workspaceRevision(dir);
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'two\n');
    const modified = await workspaceRevision(dir);
    assert.notEqual(modified, clean);

    await git(dir, 'checkout', '--', 'tracked.txt');
    await fs.writeFile(path.join(dir, 'new.txt'), 'alpha\n');
    const untrackedA = await workspaceRevision(dir);
    assert.notEqual(untrackedA, clean);

    await fs.writeFile(path.join(dir, 'new.txt'), 'beta\n');
    const untrackedB = await workspaceRevision(dir);
    assert.notEqual(untrackedB, untrackedA);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
