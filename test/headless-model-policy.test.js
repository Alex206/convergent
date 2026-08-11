'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveHeadlessRoleModels, assertHeadlessRoleModels } = require('../src/headless/model-policy');

test('headless policy validates every adaptive worker routing tier before inference', () => {
  const available = [
    { id: 'gpt-5.4', name: 'GPT-5.4' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
  ];
  const resolution = resolveHeadlessRoleModels({
    coordinator: 'strong',
    workerA: 'adaptive',
    workerB: 'adaptive-diverse',
    reviewer: 'strong',
  }, available);

  assert.equal(resolution.issues.length, 0);
  assert.equal(resolution.workers.workerA.presets.length, 4);
  assert.equal(resolution.workers.workerB.presets.length, 4);
  assert.doesNotThrow(() => assertHeadlessRoleModels(resolution));
});

test('headless policy refuses adaptive workers when their tiers would silently use auto', () => {
  const resolution = resolveHeadlessRoleModels({
    coordinator: 'strong',
    workerA: 'adaptive',
    workerB: 'adaptive-diverse',
    reviewer: 'strong',
  }, [{ id: 'gpt-5.4', name: 'GPT-5.4' }]);

  assert.ok(resolution.issues.some((issue) => issue.role === 'workerA'));
  assert.ok(resolution.issues.some((issue) => issue.role === 'workerB'));
  assert.throws(() => assertHeadlessRoleModels(resolution), /degraded to Copilot auto/i);
});
