'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const { normalizeWorkspaceFolders } = require('./workspace-scope');

async function git(workspace, args, options = {}) {
  const result = await execFileAsync('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeoutMs ?? 120_000,
  });
  return result.stdout;
}

async function workingTreeStatus(workspace) {
  return git(workspace, ['status', '--porcelain=v1', '--untracked-files=all']);
}

async function isWorkingTreeClean(workspace, workspaceFolders = null) {
  for (const root of normalizeWorkspaceFolders(workspace, workspaceFolders)) if ((await workingTreeStatus(root.path)).trim()) return false;
  return true;
}

function commitSubject(task) {
  const id = String(task?.id ?? 'task').replace(/[\r\n]+/g, ' ').trim();
  const title = String(task?.title ?? 'completed task').replace(/[\r\n]+/g, ' ').trim();
  return `convergent: ${id} ${title}`.slice(0, 180);
}

async function createTaskCommit(workspace, task) {
  if (await isWorkingTreeClean(workspace)) return null;

  await git(workspace, ['add', '-A']);
  try {
    await git(workspace, ['commit', '-m', commitSubject(task)], { timeoutMs: 180_000 });
  } catch (error) {
    // Safe-mode callers only invoke this when the task started clean, so restoring
    // the index to HEAD cannot discard pre-existing staged user changes.
    await git(workspace, ['reset', '--mixed', '--quiet', 'HEAD']).catch(() => {});
    throw error;
  }

  return (await git(workspace, ['rev-parse', 'HEAD'])).trim();
}

async function createTaskCommits(workspace, task, workspaceFolders = null) { const commits = []; for (const root of normalizeWorkspaceFolders(workspace, workspaceFolders)) { const sha = await createTaskCommit(root.path, task); if (sha) commits.push({ workspaceFolder: root.name, workspace: root.path, sha }); } return commits; }

module.exports = {
  workingTreeStatus,
  isWorkingTreeClean,
  commitSubject,
  createTaskCommit,
  createTaskCommits,
};
