'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  variantKey,
  wilsonInterval,
  aggregateRuns,
} = require('../src/headless/architecture-aggregate');

test('variant key is stable across selector object insertion order', () => {
  assert.equal(
    variantKey({ architecture: 'x', selectors: { reviewer: 'strong', implementer: 'strong' } }),
    variantKey({ architecture: 'x', selectors: { implementer: 'strong', reviewer: 'strong' } }),
  );
});

test('variant key keeps recovery policy as an independent experiment dimension', () => {
  assert.notEqual(
    variantKey({ architecture: 'implementer-reviewer', recoveryPolicy: 'none', selectors: { implementer: 'strong', reviewer: 'strong' } }),
    variantKey({ architecture: 'implementer-reviewer', recoveryPolicy: 'strong-coordinator', selectors: { implementer: 'strong', reviewer: 'strong' } }),
  );
  assert.match(
    variantKey({ architecture: 'convergent-v02', selectors: {} }),
    /recovery=strong-coordinator/,
  );
});

test('Wilson interval remains bounded and reflects small-n uncertainty', () => {
  const oneOfTwo = wilsonInterval(1, 2);
  assert.ok(oneOfTwo.low > 0);
  assert.ok(oneOfTwo.low < 0.5);
  assert.ok(oneOfTwo.high > 0.5);
  assert.ok(oneOfTwo.high < 1);

  const twoOfTwo = wilsonInterval(2, 2);
  assert.ok(twoOfTwo.low < 1);
  assert.equal(twoOfTwo.high, 1);
});

test('aggregate reports pass rate, average cost and observed cost per successful run', () => {
  const groups = aggregateRuns([
    {
      repetition: 1,
      architecture: 'single-agent',
      selectors: { implementer: 'strong' },
      oraclePass: false,
      modelCalls: 5,
      aiCredits: 8,
      elapsedMs: 30,
      inputTokens: 70,
    },
    {
      repetition: 2,
      architecture: 'single-agent',
      selectors: { implementer: 'strong' },
      oraclePass: true,
      modelCalls: 5,
      aiCredits: 9,
      elapsedMs: 32,
      inputTokens: 72,
    },
    {
      repetition: 1,
      architecture: 'implementer-reviewer',
      selectors: { implementer: 'strong', reviewer: 'strong' },
      oraclePass: true,
      modelCalls: 9,
      aiCredits: 14,
      elapsedMs: 45,
      inputTokens: 120,
    },
    {
      repetition: 2,
      architecture: 'implementer-reviewer',
      selectors: { reviewer: 'strong', implementer: 'strong' },
      oraclePass: true,
      modelCalls: 9,
      aiCredits: 16,
      elapsedMs: 47,
      inputTokens: 124,
    },
  ]);

  const reviewer = groups.find((group) => group.architecture === 'implementer-reviewer');
  const single = groups.find((group) => group.architecture === 'single-agent');
  assert.equal(reviewer.n, 2);
  assert.equal(reviewer.passes, 2);
  assert.equal(reviewer.passRate, 1);
  assert.equal(reviewer.recoveryPolicy, 'none');
  assert.equal(reviewer.averages.aiCredits, 15);
  assert.equal(reviewer.observedCostPerSuccess.aiCredits, 15);
  assert.deepEqual(reviewer.sourceRepetitions, [1, 2]);

  assert.equal(single.n, 2);
  assert.equal(single.passes, 1);
  assert.equal(single.passRate, 0.5);
  assert.equal(single.averages.aiCredits, 8.5);
  assert.equal(single.observedCostPerSuccess.aiCredits, 17);
  assert.equal(single.observedCostPerSuccess.modelCalls, 10);
});

test('missing accumulated AI-credit data is never treated as zero cost', () => {
  const [group] = aggregateRuns([
    {
      repetition: 1,
      architecture: 'copilot-default',
      selectors: { defaultAgent: 'auto' },
      oraclePass: false,
      modelCalls: 10,
      aiCredits: null,
      hasAiCreditData: false,
      premiumRequestCost: 10,
      elapsedMs: 47,
      inputTokens: 230,
    },
  ]);
  assert.equal(group.creditDataComplete, false);
  assert.equal(group.creditSamples, 0);
  assert.equal(group.averages.aiCredits, null);
  assert.equal(group.medians.aiCredits, null);
  assert.equal(group.observedCostPerSuccess, null);
  assert.equal(group.averages.premiumRequestCost, 10);
});
