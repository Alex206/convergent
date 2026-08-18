'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const { normalizeWorkspaceFolders, qualifiedWorkspacePath } = require('./workspace-scope');
const MAX_TASK_CHANGE_ENTRIES = 80;

async function git(workspace, args) {
  const { stdout } = await execFileAsync('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return String(stdout ?? '');
}

function parseNameStatusZ(output) {
  const parts = String(output ?? '').split('\0').filter(Boolean);
  const result = new Map();
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = parts[index].trim();
    const file = parts[index + 1];
    if (status && file) result.set(file, status);
  }
  return result;
}

function parseIndexZ(output) {
  const result = new Map();
  for (const record of String(output ?? '').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const metadata = record.slice(0, tab).trim();
    const file = record.slice(tab + 1);
    if (file) result.set(file, metadata);
  }
  return result;
}

async function worktreeState(workspace, relativePath) {
  const absolute = path.join(workspace, relativePath);
  try {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      return `symlink:${await fs.readlink(absolute)}`;
    }
    if (stat.isFile()) {
      const bytes = await fs.readFile(absolute);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      return `file:${digest}:exec=${stat.mode & 0o111 ? '1' : '0'}`;
    }
    if (stat.isDirectory()) return 'directory';
    return `other:${stat.mode}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    return `error:${error?.code ?? error?.message ?? String(error)}`;
  }
}

function dirtyStatus(pathname, staged, unstaged, untracked) {
  if (untracked.has(pathname)) return '??';
  const indexStatus = staged.get(pathname)?.[0] ?? ' ';
  const worktreeStatus = unstaged.get(pathname)?.[0] ?? ' ';
  return `${indexStatus}${worktreeStatus}`;
}

async function captureSingleWorkspaceChangeState(workspace, baseHead = null) {
  let head = 'NO_HEAD';
  try {
    head = (await git(workspace, ['rev-parse', 'HEAD'])).trim() || 'NO_HEAD';
  } catch {
    // Newly initialized repositories may not have a HEAD yet.
  }

  const base = baseHead && baseHead !== 'NO_HEAD' ? String(baseHead) : null;
  const [stagedOutput, unstagedOutput, untrackedOutput, indexOutput, committedOutput] = await Promise.all([
    git(workspace, ['diff', '--cached', '--name-status', '-z', '--no-renames', '--no-ext-diff']),
    git(workspace, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff']),
    git(workspace, ['ls-files', '--others', '--exclude-standard', '-z']),
    git(workspace, ['ls-files', '--stage', '-z']),
    base && head !== 'NO_HEAD' && base !== head
      ? git(workspace, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', base, head])
      : Promise.resolve(''),
  ]);

  const staged = parseNameStatusZ(stagedOutput);
  const unstaged = parseNameStatusZ(unstagedOutput);
  const untracked = new Set(untrackedOutput.split('\0').filter(Boolean));
  const index = parseIndexZ(indexOutput);
  const committed = parseNameStatusZ(committedOutput);
  const paths = [...new Set([
    ...staged.keys(),
    ...unstaged.keys(),
    ...untracked,
    ...committed.keys(),
  ])].sort();

  const entries = [];
  for (const pathname of paths) {
    const status = dirtyStatus(pathname, staged, unstaged, untracked);
    const committedStatus = committed.get(pathname) ?? '';
    const workingState = await worktreeState(workspace, pathname);
    const indexState = index.get(pathname) ?? 'not-indexed';
    const fingerprint = crypto.createHash('sha256')
      .update(status)
      .update('\0')
      .update(committedStatus)
      .update('\0')
      .update(indexState)
      .update('\0')
      .update(workingState)
      .digest('hex');
    entries.push({
      path: pathname,
      status: status.trim() ? status : (committedStatus || 'M'),
      committedStatus,
      fingerprint,
    });
  }

  return { head, entries };
}

async function captureWorkspaceChangeState(workspace, baseHead = null, workspaceFolders = null, baseHeads = null) {
  const roots = normalizeWorkspaceFolders(workspace, workspaceFolders);
  if (roots.length === 1) return captureSingleWorkspaceChangeState(roots[0].path, baseHead);
  const entries = []; const heads = {}; const states = [];
  for (const root of roots) { const state = await captureSingleWorkspaceChangeState(root.path, baseHeads?.[root.path] ?? null); heads[root.path] = state.head; states.push({ name: root.name, path: root.path, head: state.head }); for (const entry of state.entries) entries.push({ ...entry, path: qualifiedWorkspacePath(workspace, roots, root, entry.path), workspaceFolder: root.name }); }
  return { head: states.map((state) => `${state.name}:${state.head}`).join('|'), heads, roots: states, entries };
}

function buildTaskChangeManifest(baselineState, currentState) {
  const baselineEntries = Array.isArray(baselineState?.entries) ? baselineState.entries : [];
  const currentEntries = Array.isArray(currentState?.entries) ? currentState.entries : [];
  const before = new Map(baselineEntries.map((entry) => [entry.path, entry]));
  const after = new Map(currentEntries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const entries = [];

  for (const pathname of paths) {
    const prior = before.get(pathname);
    const current = after.get(pathname);
    if (!prior && current) {
      entries.push({ path: pathname, status: current.status, kind: 'changed_since_task_start' });
      continue;
    }
    if (prior && !current) {
      entries.push({ path: pathname, status: '--', kind: 'preexisting_state_changed' });
      continue;
    }
    if (prior && current && prior.fingerprint !== current.fingerprint) {
      entries.push({ path: pathname, status: current.status, kind: 'preexisting_state_changed' });
    }
  }

  return {
    baselineHead: baselineState?.head ?? 'NO_HEAD',
    currentHead: currentState?.head ?? 'NO_HEAD',
    count: entries.length,
    entries,
  };
}

function displayPath(value) {
  return String(value ?? '').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function formatTaskChangeManifest(manifest, heading = 'TASK CHANGE MANIFEST') {
  if (!manifest) return '';
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  if (!entries.length) {
    return `${heading}: no workspace paths differ from the task-start change snapshot.`;
  }

  const shown = entries.slice(0, MAX_TASK_CHANGE_ENTRIES);
  const omitted = Math.max(0, entries.length - shown.length);
  return [
    `${heading} (${entries.length} path${entries.length === 1 ? '' : 's'} changed relative to task start):`,
    ...shown.map((entry) => {
      const note = entry.kind === 'preexisting_state_changed'
        ? ' [pre-existing path changed since task start]'
        : '';
      return `- ${String(entry.status ?? '').padEnd(2)} ${displayPath(entry.path)}${note}`;
    }),
    omitted ? `- ... ${omitted} additional changed path${omitted === 1 ? '' : 's'} omitted to bound prompt size.` : '',
    'Convergent computed this from the task-start workspace snapshot and current Git/worktree state. Use these exact repository-relative paths as changed-file hints before searching for paths. This is deterministic change evidence, not proof of agent ownership; unchanged pre-existing dirty/staged/untracked paths are intentionally excluded.',
  ].filter(Boolean).join('\n');
}

module.exports = {
  captureWorkspaceChangeState,
  captureSingleWorkspaceChangeState,
  buildTaskChangeManifest,
  formatTaskChangeManifest,
  parseNameStatusZ,
  parseIndexZ,
  MAX_TASK_CHANGE_ENTRIES,
};
