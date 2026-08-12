'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  isWithin,
  riskyCommand,
  sensitiveEnvironmentCommand,
} = require('../src/copilot/permissions');
const { createHeadlessPermissionHandler } = require('../src/headless/runner');

test('workspace path containment', () => {
  const root = path.resolve('/tmp/project');
  assert.equal(isWithin(root, path.join(root, 'src', 'a.js')), true);
  assert.equal(isWithin(root, path.join('src', 'a.js')), true);
  assert.equal(isWithin(root, path.resolve('/tmp/other/a.js')), false);
});

test('risky commands are detected', () => {
  assert.equal(riskyCommand('git push origin main'), true);
  assert.equal(riskyCommand('git reset --hard HEAD~1'), true);
  assert.equal(riskyCommand('npm test'), false);
});

test('sensitive environment inspection is classified as risky', () => {
  const sensitive = [
    'printenv',
    'env | sort',
    'echo $COPILOT_GITHUB_TOKEN',
    'Get-ChildItem Env:',
    '[Environment]::GetEnvironmentVariables()',
    'node -e "console.log(process.env)"',
    'python -c "import os; print(os.environ)"',
  ];
  for (const command of sensitive) {
    assert.equal(sensitiveEnvironmentCommand(command), true, command);
    assert.equal(riskyCommand(command), true, command);
  }

  const safe = [
    'python -B -m unittest',
    'npm test',
    'git status --short',
    'git diff --check',
  ];
  for (const command of safe) {
    assert.equal(sensitiveEnvironmentCommand(command), false, command);
  }
});

test('headless permission gate denies environment probing but permits normal validation', async () => {
  const errors = [];
  const handler = createHeadlessPermissionHandler('/tmp/work', {
    logger: { error: (message) => errors.push(message) },
  });

  assert.equal((await handler({ kind: 'shell', fullCommandText: 'npm test' })).kind, 'approve-once');
  assert.equal((await handler({ kind: 'shell', fullCommandText: 'printenv' })).kind, 'deny');
  assert.equal((await handler({ kind: 'shell', fullCommandText: 'echo $GITHUB_TOKEN' })).kind, 'deny');
  assert.equal(errors.length, 2);
});
