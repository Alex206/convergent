'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function git(workspace, args, options = {}) {
  const result = await execFileAsync('git', ['-C', workspace, ...args], {
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return result.stdout;
}

async function assertGitRepository(workspace) {
  try {
    const inside = (await git(workspace, ['rev-parse', '--is-inside-work-tree'])).trim();
    if (inside !== 'true') throw new Error('not a work tree');
  } catch (error) {
    throw new Error(`Convergent currently requires the workspace to be a Git repository: ${error.message}`);
  }
}

async function readUntracked(workspace) {
  const output = await git(workspace, ['ls-files', '--others', '--exclude-standard', '-z']);
  const files = output.split('\0').filter(Boolean).sort();
  const chunks = [];
  for (const relative of files) {
    const absolute = path.join(workspace, relative);
    try {
      const stat = await fs.stat(absolute);
      if (stat.isFile()) {
        chunks.push(Buffer.from(relative));
        chunks.push(await fs.readFile(absolute));
      }
    } catch {
      // The file may have disappeared between git listing and reading; the next fingerprint will catch it.
    }
  }
  return chunks;
}

async function workspaceRevision(workspace) {
  await assertGitRepository(workspace);
  let head = 'NO_HEAD';
  try {
    head = (await git(workspace, ['rev-parse', 'HEAD'])).trim();
  } catch {
    // A newly initialized repository may not have HEAD yet.
  }

  const [unstaged, staged, untracked] = await Promise.all([
    git(workspace, ['diff', '--binary', '--no-ext-diff']),
    git(workspace, ['diff', '--binary', '--cached', '--no-ext-diff']),
    readUntracked(workspace),
  ]);

  const hash = crypto.createHash('sha256');
  hash.update(head);
  hash.update('\0UNSTAGED\0');
  hash.update(unstaged);
  hash.update('\0STAGED\0');
  hash.update(staged);
  hash.update('\0UNTRACKED\0');
  for (const chunk of untracked) hash.update(chunk);
  return hash.digest('hex');
}

module.exports = { workspaceRevision, assertGitRepository };
