'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPlanTool,
  createPassTool,
  createReviewTool,
  normalizePassReport,
  normalizeReviewReport,
} = require('../src/copilot/tools');

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

test('pass reports normalize non-array findings and checks instead of crashing peer exchange', () => {
  const report = normalizePassReport({
    verdict: 'changed',
    summary: 'fixed issue',
    findings: { title: 'Race', description: 'Shutdown can race.' },
    checks: 'tests passed',
  });
  assert.deepEqual(report.findings, ['Race: Shutdown can race.']);
  assert.deepEqual(report.checks, ['tests passed']);
});

test('review reports normalize a single string finding into the strong-review shape', () => {
  const report = normalizeReviewReport({
    verdict: 'findings',
    summary: 'one issue',
    findings: 'Missing negative-path test',
    checks: null,
  });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].severity, 'medium');
  assert.equal(report.findings[0].description, 'Missing negative-path test');
  assert.deepEqual(report.checks, []);
});
