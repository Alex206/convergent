'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeArchitecture } = require('../src/headless/topologies');

test('architecture CLI default resolves to released Convergent reference topology', () => {
  assert.equal(normalizeArchitecture(undefined), 'convergent-v02');
});
