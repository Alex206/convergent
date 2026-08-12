'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createBatchViewTool } = require('../src/copilot/batch-view-tool');
const { globToRegExp, parseGrepLine } = require('../src/copilot/batch-search-tool');

const execFileAsync = promisify(execFile);

async function withGitWorkspace(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-batch-inspection-'));
  try {
    await execFileAsync('git', ['init', '-q', root]);
    await fs.mkdir(path.join(root, 'taskflow'));
    await fs.mkdir(path.join(root, 'tests'));
    await fs.writeFile(path.join(root, 'taskflow', 'models.py'), 'class TaskSpec:\n    pass\n', 'utf8');
    await fs.writeFile(path.join(root, 'taskflow', 'config.py'), 'class ConfigError(ValueError):\n    pass\n\ndef parse_tasks(items):\n    return items\n', 'utf8');
    await fs.writeFile(path.join(root, 'taskflow', '__init__.py'), 'from .models import TaskSpec\n', 'utf8');
    await fs.writeFile(path.join(root, 'tests', 'test_config.py'), 'def test_parse():\n    pass\n', 'utf8');
    await execFileAsync('git', ['-C', root, 'add', '.']);
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

test('batch_view locates several symbols/globs and reads their files in one tool call', async () => {
  await withGitWorkspace(async (root) => {
    const result = await toolFor(root).handler({
      queries: ['class TaskSpec', 'def parse_tasks', 'class ConfigError'],
      globs: ['taskflow/*.py', 'tests/test_*.py'],
      readMatches: true,
    });

    assert.equal(result.searches.length, 3);
    assert.equal(result.searches[0].matches[0].path, 'taskflow/models.py');
    assert.equal(result.searches[1].matches[0].path, 'taskflow/config.py');
    assert.equal(result.searches[2].matches[0].path, 'taskflow/config.py');
    assert.deepEqual(result.globs[0].paths.sort(), ['taskflow/__init__.py', 'taskflow/config.py', 'taskflow/models.py']);
    assert.deepEqual(result.globs[1].paths, ['tests/test_config.py']);

    const files = new Map(result.files.map((entry) => [entry.path, entry]));
    assert.equal(files.get('taskflow/models.py').content.includes('class TaskSpec'), true);
    assert.equal(files.get('taskflow/config.py').content.includes('def parse_tasks'), true);
    assert.equal(files.get('taskflow/__init__.py').content.includes('TaskSpec'), true);
    assert.equal(files.get('tests/test_config.py').content.includes('test_parse'), true);
    assert.equal(result.files.length, 4);
  });
});

test('batch search helpers preserve literal grep evidence and tracked-file glob semantics', () => {
  assert.deepEqual(parseGrepLine('taskflow/config.py:42:def parse_tasks(items):'), {
    path: 'taskflow/config.py',
    line: 42,
    text: 'def parse_tasks(items):',
  });
  const matcher = globToRegExp('tests/**/test_*.py');
  assert.equal(matcher.test('tests/test_config.py'), true);
  assert.equal(matcher.test('tests/unit/test_config.py'), true);
  assert.equal(matcher.test('taskflow/test_config.py'), false);
});
