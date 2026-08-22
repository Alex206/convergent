'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const { normalizeWorkspaceFolders, qualifiedWorkspacePath } = require('./workspace-scope');

const execFileAsync = promisify(execFile);
const MAX_PROMPT_ENTRIES = 50;

async function captureWorkspaceBaseline(workspace, workspaceFolders = null) {
  const roots = normalizeWorkspaceFolders(workspace, workspaceFolders); const entries = [];
  for (const root of roots) {
    const { stdout } = await execFileAsync('git', ['-C', root.path, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const lines = String(stdout ?? '').replace(/\r\n/g, '\n').trimEnd().split('\n').filter(Boolean);
    for (const line of lines) entries.push(`${line.slice(0, 3)}${qualifiedWorkspacePath(workspace, roots, root, line.slice(3))}`);
  }
  const statusText = entries.join('\n');
  return { clean: entries.length === 0, count: entries.length, entries, roots: roots.map((root) => ({ name: root.name, path: root.path })), sha256: crypto.createHash('sha256').update(statusText).digest('hex') };
}

function formatWorkspaceBaseline(baseline) {
  if (!baseline || baseline.clean) {
    return [
      'TASK-START WORKSPACE BASELINE:',
      'Convergent observed a clean Git worktree immediately before this task\'s Worker A/B/reviewer sessions were created.',
    ].join('\n');
  }

  const shown = baseline.entries.slice(0, MAX_PROMPT_ENTRIES);
  const omitted = Math.max(0, baseline.count - shown.length);
  return [
    'TASK-START WORKSPACE BASELINE (user-owned pre-existing state):',
    `Before Worker A made any task changes, Convergent observed ${baseline.count} dirty/staged/untracked Git status entr${baseline.count === 1 ? 'y' : 'ies'}:`,
    ...shown.map((entry) => `- ${entry}`),
    omitted ? `- ... ${omitted} additional pre-existing status entr${omitted === 1 ? 'y' : 'ies'} omitted from the prompt to bound context size.` : '',
    'These entries existed before this task. They are NOT task-introduced changes merely because they are still present later. Do not report, remove, revert, overwrite, or stage them just to make the task revision/status clean. Only act on one when the task explicitly requires changing it or there is concrete evidence this task itself subsequently modified it.',
  ].filter(Boolean).join('\n');
}

module.exports = { captureWorkspaceBaseline, formatWorkspaceBaseline, MAX_PROMPT_ENTRIES };