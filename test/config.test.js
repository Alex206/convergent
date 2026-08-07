'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('strong coordinator is the default configuration', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const properties = pkg.contributes.configuration.properties;
  assert.equal(properties['convergent.models.coordinator'].default, 'strong');
  assert.match(properties['convergent.models.coordinator'].description, /requirements understanding/i);
});
