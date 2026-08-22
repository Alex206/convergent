'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const { normalizeWorkspaceFolders, qualifiedWorkspacePath } = require('./workspace-scope');
const MAX_TASK_CHANGE_ENTRIES = 80;
const MAX_TASK_REVIEW_DIFF_ENTRIES = 12;
const MAX_TASK_REVIEW_DIFF_PER_FILE_CHARS = 6_000;
const MAX_TASK_REVIEW_DIFF_CHARS = 24_000;

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

function boundedText(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 80))}\n... [Convergent truncated this diff to ${maxChars} characters]`;
}

async function untrackedReviewDiff(workspace, pathname) {
  try {
    const bytes = await fs.readFile(path.join(workspace, pathname));
    if (bytes.includes(0)) return `diff --git a/${pathname} b/${pathname}\n[untracked binary file content omitted]`;
    const text = bytes.toString('utf8');
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    const body = lines.map((line) => `+${line}`).join('\n');
    return boundedText([
      `diff --git a/${pathname} b/${pathname}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${pathname}`,
      `@@ -0,0 +1,${lines.length} @@`,
      body,
    ].join('\n'), MAX_TASK_REVIEW_DIFF_PER_FILE_CHARS);
  } catch (error) {
    return `diff --git a/${pathname} b/${pathname}\n[untracked file diff unavailable: ${error?.code ?? error?.message ?? String(error)}]`;
  }
}

async function reviewDiffForPath(workspace, base, pathname, isUntracked) {
  if (!base) return '';
  if (isUntracked) return untrackedReviewDiff(workspace, pathname);
  try {
    const output = await git(workspace, ['diff', '--no-ext-diff', '--no-renames', '--unified=3', base, '--', pathname]);
    return boundedText(output, MAX_TASK_REVIEW_DIFF_PER_FILE_CHARS);
  } catch (error) {
    return `diff --git a/${pathname} b/${pathname}\n[task review diff unavailable: ${error?.message ?? String(error)}]`;
  }
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
  let reviewDiffEntries = 0;
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
    let reviewDiff = '';
    if (base && reviewDiffEntries < MAX_TASK_REVIEW_DIFF_ENTRIES) {
      reviewDiff = await reviewDiffForPath(workspace, base, pathname, untracked.has(pathname));
      if (reviewDiff) reviewDiffEntries += 1;
    }
    entries.push({
      path: pathname,
      status: status.trim() ? status : (committedStatus || 'M'),
      committedStatus,
      fingerprint,
      ...(reviewDiff ? { reviewDiff } : {}),
    });
  }

  return { head, entries };
}

async function captureWorkspaceChangeState(workspace, baseHead = null, workspaceFolders = null, baseHeads = null) {
  const roots = normalizeWorkspaceFolders(workspace, workspaceFolders);
  if (roots.length === 1) return captureSingleWorkspaceChangeState(roots[0].path, baseHead);
  const entries = []; const heads = {}; const states = [];
  for (const root of roots) {
    const state = await captureSingleWorkspaceChangeState(root.path, baseHeads?.[root.path] ?? null);
    heads[root.path] = state.head;
    states.push({ name: root.name, path: root.path, head: state.head });
    for (const entry of state.entries) entries.push({ ...entry, path: qualifiedWorkspacePath(workspace, roots, root, entry.path), workspaceFolder: root.name });
  }
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
      entries.push({ path: pathname, status: current.status, kind: 'changed_since_task_start', reviewDiff: current.reviewDiff ?? '' });
      continue;
    }
    if (prior && !current) {
      entries.push({ path: pathname, status: '--', kind: 'preexisting_state_changed', reviewDiff: '' });
      continue;
    }
    if (prior && current && prior.fingerprint !== current.fingerprint) {
      entries.push({ path: pathname, status: current.status, kind: 'preexisting_state_changed', reviewDiff: current.reviewDiff ?? '' });
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

function formatReviewDiff(entries) {
  const blocks = entries
    .filter((entry) => String(entry.reviewDiff ?? '').trim())
    .slice(0, MAX_TASK_REVIEW_DIFF_ENTRIES)
    .map((entry) => [
      `### ${displayPath(entry.path)}${entry.kind === 'preexisting_state_changed' ? ' [pre-existing path changed]' : ''}`,
      '```diff',
      String(entry.reviewDiff).trimEnd(),
      '```',
    ].join('\n'));
  if (!blocks.length) return '';
  return boundedText([
    'Bounded current diff evidence for task-change paths:',
    ...blocks,
    'This is the current workspace diff against the task-start HEAD for each repository. For a path that was already dirty at task start, the diff can include pre-task hunks; the manifest marker above is the deterministic evidence that the path itself changed during this task. Use this packet before reopening whole files, and expand only around a concrete uncertainty.',
  ].join('\n\n'), MAX_TASK_REVIEW_DIFF_CHARS);
}

function formatTaskChangeManifest(manifest, heading = 'TASK CHANGE MANIFEST') {
  if (!manifest) return '';
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  if (!entries.length) {
    return `${heading}: no workspace paths differ from the task-start change snapshot.`;
  }

  const shown = entries.slice(0, MAX_TASK_CHANGE_ENTRIES);
  const omitted = Math.max(0, entries.length - shown.length);
  const reviewDiff = formatReviewDiff(shown);
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
    reviewDiff ? `\n${reviewDiff}` : '',
  ].filter(Boolean).join('\n');
}

module.exports = {
  captureWorkspaceChangeState,
  captureSingleWorkspaceChangeState,
  buildTaskChangeManifest,
  formatTaskChangeManifest,
  formatReviewDiff,
  parseNameStatusZ,
  parseIndexZ,
  boundedText,
  MAX_TASK_CHANGE_ENTRIES,
  MAX_TASK_REVIEW_DIFF_ENTRIES,
  MAX_TASK_REVIEW_DIFF_PER_FILE_CHARS,
  MAX_TASK_REVIEW_DIFF_CHARS,
};
