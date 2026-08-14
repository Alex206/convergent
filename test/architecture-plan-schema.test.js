'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePlan, validatePlan } = require('../src/copilot/tools');

test('plan normalization preserves architecture significance independently from risk', () => {
  const plan = normalizePlan({
    summary: 'one task',
    tasks: [{
      id: 't1',
      title: 'Add runtime provider boundary',
      description: 'Introduce a provider boundary without security-sensitive behavior.',
      acceptanceCriteria: ['Boundary is implemented'],
      route: 'standard',
      risk: 'low',
      architectureSignificance: 'high',
      routingReason: 'cross-cutting ownership change',
    }],
  });

  assert.equal(plan.tasks[0].risk, 'low');
  assert.equal(plan.tasks[0].architectureSignificance, 'high');
  assert.equal(validatePlan(plan), null);
});

test('invalid explicit architecture significance is rejected while omission remains backward compatible', () => {
  const invalid = normalizePlan({
    summary: 'one task',
    tasks: [{
      id: 't1',
      title: 'Change helper',
      description: 'Change helper.',
      acceptanceCriteria: ['Works'],
      route: 'standard',
      risk: 'low',
      architectureSignificance: 'huge',
      routingReason: 'local',
    }],
  });
  assert.match(validatePlan(invalid), /architectureSignificance/);

  const legacy = normalizePlan({
    summary: 'one task',
    tasks: [{
      id: 't1',
      title: 'Change helper',
      description: 'Change helper.',
      acceptanceCriteria: ['Works'],
      route: 'standard',
      risk: 'low',
      routingReason: 'local',
    }],
  });
  assert.equal(validatePlan(legacy), null);
});
