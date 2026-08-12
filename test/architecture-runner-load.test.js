'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const runner = require('../src/headless/architecture-runner');

test('architecture benchmark runner exposes one explicit experimental entrypoint', () => {
  assert.equal(typeof runner.runArchitectureBenchmark, 'function');
});
