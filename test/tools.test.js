'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlanTool, createPassTool, createReviewTool } = require('../src/copilot/tools');

function captureDefinition(name, definition) {
  return { name, ...definition };
}

test('structured report tools stay eagerly available to agents', () => {
  for (const factory of [createPlanTool, createPassTool, createReviewTool]) {
    const tool = factory(captureDefinition, { value: null });
    assert.equal(tool.defer, 'never');
    assert.equal(tool.skipPermission, true);
  }
});
