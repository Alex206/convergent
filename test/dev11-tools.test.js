'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlanTool } = require('../src/copilot/tools');

test('report_plan accepts bounded coordinator inspection hints for modifying tasks', async () => {
  const sink = { value: null };
  let definition;
  const defineTool = (name, options) => {
    definition = { name, ...options };
    return definition;
  };
  createPlanTool(defineTool, sink);

  const hints = definition.parameters.properties.tasks.items.properties.inspectionHints;
  assert.equal(hints.type, 'array');
  assert.equal(hints.maxItems, 12);
  assert.match(hints.description, /non-authoritative/i);

  const plan = {
    summary: 'One task',
    tasks: [{
      id: 't1',
      title: 'Change retry logic',
      description: 'Implement retry backoff.',
      acceptanceCriteria: ['Backoff is configurable'],
      route: 'standard',
      risk: 'medium',
      routingReason: 'Executable behavior change',
      inspectionHints: ['taskflow/models.py', 'taskflow/config.py', 'tests/test_config.py'],
    }],
  };
  const result = await definition.handler(plan);
  assert.equal(result.accepted, true);
  assert.deepEqual(sink.value.tasks[0].inspectionHints, plan.tasks[0].inspectionHints);
});
