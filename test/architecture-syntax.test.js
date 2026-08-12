'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FILES = [
  'src/headless/architecture-catalog.js',
  'src/headless/architecture-cli.js',
  'src/headless/architecture-runner.js',
  'src/headless/architecture-summary.js',
  'src/headless/architecture-aggregate.js',
  'src/headless/default-copilot-engine.js',
  'src/headless/scenario04-architecture-acceptance.js',
  'src/headless/topologies.js',
];

test('all architecture benchmark entrypoints pass node --check', () => {
  for (const file of FILES) {
    const result = spawnSync(process.execPath, ['--check', path.resolve(file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}\n${result.stdout}\n${result.stderr}`);
  }
});
