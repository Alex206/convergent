'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPlanTool,
  normalizePlan,
  validatePlan,
} = require('../src/copilot/tools');

function defineTool(name, options) {
  return { name, ...options };
}

function validTask(overrides = {}) {
  return {
    id: 'implement-ordering',
    title: 'Implement dependency ordering',
    description: 'Implement dependency-aware ordering with focused tests.',
    acceptanceCriteria: ['Dependencies are parsed and validated', 'Ordering is stable and deterministic'],
    route: 'standard',
    risk: 'medium',
    routingReason: 'Changes executable dependency-ordering behavior.',
    inspectionHints: ['taskflow/models.py', 'taskflow/config.py'],
    ...overrides,
  };
}

test('valid modifying coordinator plan is normalized and accepted authoritatively', async () => {
  const sink = { value: null };
  const tool = createPlanTool(defineTool, sink);
  const raw = {
    summary: 'Implement dependency ordering as one cohesive task.',
    tasks: [validTask({ inspectionHints: [' taskflow/models.py ', '', 'taskflow/config.py'] })],
  };

  const expected = normalizePlan(raw);
  assert.equal(validatePlan(expected), null);
  const result = await tool.handler(raw);

  assert.deepEqual(result, { accepted: true, taskCount: 1 });
  assert.deepEqual(sink.value, expected);
  assert.deepEqual(sink.value.tasks[0].inspectionHints, ['taskflow/models.py', 'taskflow/config.py']);
});

test('malformed live-style plan with required fields embedded in description is rejected and never becomes authoritative', async () => {
  const sink = { value: null };
  const tool = createPlanTool(defineTool, sink);
  const malformed = {
    summary: 'Dependency ordering plan',
    tasks: [{
      id: 'implement-ordering',
      title: 'Implement dependency ordering',
      description: [
        'Implement dependency ordering.',
        'AcceptanceCriteria: dependencies are validated; ordering is stable.',
        'route: standard',
        'risk: medium',
        'routingReason: executable behavior change',
      ].join('\n'),
      inspectionHints: ['taskflow/config.py'],
    }],
  };

  const result = await tool.handler(malformed);
  assert.equal(result.accepted, false);
  assert.equal(result.retry, true);
  assert.match(result.error, /acceptanceCriteria as a non-empty top-level array/);
  assert.equal(sink.value, null);
});

test('read-only task requires completed result before plan acceptance', async () => {
  const sink = { value: null };
  const tool = createPlanTool(defineTool, sink);
  const raw = {
    summary: 'Inspect configuration only.',
    tasks: [validTask({
      id: 'inspect',
      title: 'Inspect configuration',
      description: 'Answer the requested configuration question.',
      acceptanceCriteria: ['Return the requested answer'],
      route: 'read_only',
      risk: 'low',
      routingReason: 'No modification requested.',
      result: '',
    })],
  };

  const result = await tool.handler(raw);
  assert.equal(result.accepted, false);
  assert.equal(result.retry, true);
  assert.match(result.error, /requires a completed top-level result/);
  assert.equal(sink.value, null);

  raw.tasks[0].result = 'The configuration uses TaskSpec from taskflow.models.';
  const accepted = await tool.handler(raw);
  assert.deepEqual(accepted, { accepted: true, taskCount: 1 });
  assert.equal(sink.value.tasks[0].result, raw.tasks[0].result);
});

test('duplicate task ids fail closed at the plan boundary', async () => {
  const sink = { value: null };
  const tool = createPlanTool(defineTool, sink);
  const raw = {
    summary: 'Two independent tasks.',
    tasks: [validTask(), validTask({ title: 'Second task' })],
  };

  const result = await tool.handler(raw);
  assert.equal(result.accepted, false);
  assert.equal(result.retry, true);
  assert.match(result.error, /duplicated/);
  assert.equal(sink.value, null);
});
