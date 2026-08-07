'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isWithin, riskyCommand } = require('../src/copilot/permissions');

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
