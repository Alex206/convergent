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

test('plan schema requires workflow route, risk, and rationale for every task', () => {
  const tool = createPlanTool(captureDefinition, { value: null });
  const taskSchema = tool.parameters.properties.tasks.items;
  assert.deepEqual(taskSchema.properties.route.enum, ['read_only', 'trivial', 'standard', 'high_risk']);
  assert.deepEqual(taskSchema.properties.risk.enum, ['low', 'medium', 'high']);
  assert.ok(taskSchema.required.includes('route'));
  assert.ok(taskSchema.required.includes('risk'));
  assert.ok(taskSchema.required.includes('routingReason'));
});
