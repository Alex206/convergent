'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceEditTool } = require('../src/copilot/workspace-edit-tool');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-workspace-edit-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const a = path.join(base, 'repo-a'); const b = path.join(base, 'repo-b');
  await fs.mkdir(a); await fs.mkdir(b);
  await fs.writeFile(path.join(a, 'a.txt'), 'alpha\n');
  await fs.writeFile(path.join(b, 'b.txt'), 'beta old\n');
  return { a, b, roots: [{ name: 'repo-a', path: a }, { name: 'repo-b', path: b }] };
}
function define(f, permissions = []) {
  let tool;
  createWorkspaceEditTool((name, config) => (tool = { name, ...config }), {
    workspace: f.a,
    workspaceFolders: f.roots,
    owner: 'Worker A',
    permissionHandler: async (request) => { permissions.push(request); return { kind: 'approve-once' }; },
  });
  return tool;
}

test('workspace_edit replaces and creates files in a secondary workspace root', async (t) => {
  const f = await fixture(t); const permissions = []; const tool = define(f, permissions);
  const result = await tool.handler({ operations: [
    { workspaceFolder: 'repo-b', path: 'b.txt', operation: 'replace', oldText: 'beta old', newText: 'beta new' },
    { workspaceFolder: 'repo-b', path: 'created.txt', operation: 'create', content: 'created\n' },
  ] });
  assert.equal(result.accepted, true);
  assert.equal(await fs.readFile(path.join(f.b, 'b.txt'), 'utf8'), 'beta new\n');
  assert.equal(await fs.readFile(path.join(f.b, 'created.txt'), 'utf8'), 'created\n');
  assert.deepEqual(result.results.map((item) => item.path), ['repo-b::b.txt', 'repo-b::created.txt']);
  assert.equal(permissions.length, 2);
  assert.ok(permissions.every((request) => path.resolve(request.fileName).startsWith(path.resolve(f.b))));
});

test('workspace_edit deletes a secondary-root file and fails closed on path escape', async (t) => {
  const f = await fixture(t); const tool = define(f);
  const deleted = await tool.handler({ operations: [{ workspaceFolder: 'repo-b', path: 'b.txt', operation: 'delete' }] });
  assert.equal(deleted.accepted, true);
  await assert.rejects(fs.stat(path.join(f.b, 'b.txt')));
  const escaped = await tool.handler({ operations: [{ workspaceFolder: 'repo-b', path: '../repo-a/a.txt', operation: 'delete' }] });
  assert.equal(escaped.accepted, false);
  assert.match(escaped.error, /stay inside workspace folder/i);
  assert.equal(await fs.readFile(path.join(f.a, 'a.txt'), 'utf8'), 'alpha\n');
});

test('workspace_edit requires an exact unique replacement and refuses .git paths', async (t) => {
  const f = await fixture(t); const tool = define(f);
  await fs.writeFile(path.join(f.b, 'b.txt'), 'same\nsame\n');
  const ambiguous = await tool.handler({ operations: [{ workspaceFolder: 'repo-b', path: 'b.txt', operation: 'replace', oldText: 'same', newText: 'other' }] });
  assert.equal(ambiguous.accepted, false);
  assert.match(ambiguous.error, /exactly once/i);
  const git = await tool.handler({ operations: [{ workspaceFolder: 'repo-b', path: '.git/config', operation: 'create', content: 'bad' }] });
  assert.equal(git.accepted, false);
  assert.match(git.error, /\.git/i);
});

test('workspace_edit denies symlink escapes when supported', async (t) => {
  const f = await fixture(t); const tool = define(f);
  const outside = path.join(path.dirname(f.a), 'outside.txt');
  await fs.writeFile(outside, 'outside\n');
  const link = path.join(f.b, 'link.txt');
  try { await fs.symlink(outside, link); } catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return; throw error; }
  const result = await tool.handler({ operations: [{ workspaceFolder: 'repo-b', path: 'link.txt', operation: 'replace', oldText: 'outside', newText: 'changed' }] });
  assert.equal(result.accepted, false);
  assert.match(result.error, /escapes workspace folder/i);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside\n');
});
