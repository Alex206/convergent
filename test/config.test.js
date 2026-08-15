'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('strong coordinator remains the conditional planning and recovery default', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const properties = pkg.contributes.configuration.properties;
  const coordinator = properties['convergent.models.coordinator'];
  assert.equal(coordinator.default, 'strong');
  assert.match(coordinator.description, /planning\/recovery coordinator/i);
  assert.match(coordinator.description, /deterministic single-task formation/i);
  assert.match(coordinator.description, /real BLOCKED state/i);
});
