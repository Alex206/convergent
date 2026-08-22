'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { architectureInspectionHints } = require('../src/orchestrator/architecture-advisor');

test('software architect receives bounded coordinator inspection hints instead of rediscovering surfaces', () => {
  const text = architectureInspectionHints({
    inspectionHints: [
      'src/generation/stub_generator.py owns generated include rendering',
      'tests/unit/spec_generation.py contains the focused generation regressions',
      'real host fixture is configured by unit_test_host.yaml',
    ],
  });

  assert.match(text, /PLANNING INSPECTION HANDOFF/);
  assert.match(text, /stub_generator\.py/);
  assert.match(text, /spec_generation\.py/);
  assert.match(text, /unit_test_host\.yaml/);
  assert.match(text, /Do not repeat broad glob\/rg\/repository discovery/i);
});

test('architect planning handoff is bounded and absent when planning found nothing concrete', () => {
  assert.equal(architectureInspectionHints({}), '');
  const text = architectureInspectionHints({ inspectionHints: Array.from({ length: 20 }, (_, index) => `hint-${index}`) });
  assert.match(text, /hint-0/);
  assert.match(text, /hint-11/);
  assert.doesNotMatch(text, /hint-12/);
});
