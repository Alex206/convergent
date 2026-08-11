'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createBatchViewTool,
  relativePathAllowed,
  MAX_BATCH_VIEW_CHARS_PER_FILE,
  MAX_BATCH_VIEW_TOTAL_CHARS,
} = require('../src/copilot/batch-view-tool');
const {
  BATCH_VIEW_TOOL,
  COORDINATOR_TOOLS,
  RECOVERY_COORDINATOR_TOOLS,
  REVIEWER_TOOLS,
  WORKER_TOOLS,
} = require('../src/copilot/session-factory');

async function withWorkspace(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-batch-view-'));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function toolFor(workspace) {
  let definition;
  createBatchViewTool((name, options) => {
    definition = { name, ...options };
    return definition;
  }, workspace);
  return definition;
}

test('batch_view reads several text files in request order and preserves missing-file evidence', async () => {
  await withWorkspace(async (root) => {
    await fs.mkdir(path.join(root, 'pkg'));
    await fs.writeFile(path.join(root, 'pkg', 'a.py'), 'A\n', 'utf8');
    await fs.writeFile(path.join(root, 'pkg', 'b.py'), 'B\n', 'utf8');
    const tool = toolFor(root);

    const result = await tool.handler({ paths: ['pkg/b.py', 'missing.py', 'pkg/a.py'] });
    assert.deepEqual(result.files.map((entry) => entry.path), ['pkg/b.py', 'missing.py', 'pkg/a.py']);
    assert.equal(result.files[0].content, 'B\n');
    assert.deepEqual(result.files[1], { path: 'missing.py', ok: false, error: 'not_found' });
    assert.equal(result.files[2].content, 'A\n');
    assert.equal(result.totalChars, 4);
  });
});

test('batch_view rejects absolute, traversal, .git and cross-platform absolute paths', async () => {
  await withWorkspace(async (root) => {
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.git', 'config'), 'secret', 'utf8');
    const tool = toolFor(root);
    const absolute = path.join(root, 'inside.txt');
    await fs.writeFile(absolute, 'inside', 'utf8');

    const result = await tool.handler({ paths: [absolute, '../outside.txt', '.git/config', 'C:\\Users\\x\\token.txt', '/etc/passwd'] });
    assert.equal(result.files.every((entry) => entry.ok === false && entry.error === 'invalid_path'), true);
    assert.equal(relativePathAllowed('pkg/file.py'), true);
    assert.equal(relativePathAllowed('..\\outside.txt'), false);
  });
});

test('batch_view denies symlinks resolving outside the workspace when symlinks are available', async (t) => {
  await withWorkspace(async (root) => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-batch-view-outside-'));
    try {
      const outside = path.join(outsideRoot, 'secret.txt');
      await fs.writeFile(outside, 'outside-secret', 'utf8');
      try {
        await fs.symlink(outside, path.join(root, 'escape.txt'));
      } catch (error) {
        if (error?.code === 'EPERM' || error?.code === 'EACCES') {
          t.skip('file symlinks are not permitted on this runner');
          return;
        }
        throw error;
      }
      const result = await toolFor(root).handler({ paths: ['escape.txt'] });
      assert.deepEqual(result.files[0], { path: 'escape.txt', ok: false, error: 'outside_workspace' });
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

test('batch_view bounds each file and the combined returned text', async () => {
  await withWorkspace(async (root) => {
    const big = 'x'.repeat(MAX_BATCH_VIEW_CHARS_PER_FILE + 1000);
    const paths = [];
    for (let index = 0; index < 6; index += 1) {
      const name = `f${index}.txt`;
      paths.push(name);
      await fs.writeFile(path.join(root, name), big, 'utf8');
    }

    const result = await toolFor(root).handler({ paths });
    assert.equal(result.files[0].content.length, MAX_BATCH_VIEW_CHARS_PER_FILE);
    assert.equal(result.files[0].truncated, true);
    assert.equal(result.totalChars, MAX_BATCH_VIEW_TOTAL_CHARS);
    assert.equal(result.files.reduce((sum, entry) => sum + (entry.content?.length ?? 0), 0), MAX_BATCH_VIEW_TOTAL_CHARS);
    assert.equal(result.files.some((entry) => entry.ok && entry.content.length === 0 && entry.truncated), true);
  });
});

test('batch_view is present in every Convergent role that can inspect repository files', () => {
  assert.equal(BATCH_VIEW_TOOL, 'custom:batch_view');
  for (const tools of [COORDINATOR_TOOLS, RECOVERY_COORDINATOR_TOOLS, REVIEWER_TOOLS, WORKER_TOOLS]) {
    assert.equal(tools.includes(BATCH_VIEW_TOOL), true);
  }
});
