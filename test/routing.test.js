'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTaskRoute, routePolicy, chooseReasoningEffort } = require('../src/orchestrator/routing');

test('high-risk modifying tasks cannot use a lighter route', () => {
  const routing = normalizeTaskRoute({ route: 'trivial', risk: 'high', routingReason: 'small diff' });
  assert.equal(routing.route, 'high_risk');
  assert.equal(routing.overridden, true);
});

test('medium-risk trivial tasks are upgraded to standard', () => {
  assert.equal(normalizeTaskRoute({ route: 'trivial', risk: 'medium' }).route, 'standard');
});

test('full routing mode forces modifying trivial tasks through full review', () => {
  assert.equal(normalizeTaskRoute({ route: 'trivial', risk: 'low' }, 'full').route, 'standard');
});

test('read-only tasks remain coordinator-only even in full mode', () => {
  assert.equal(normalizeTaskRoute({ route: 'read_only', risk: 'low', result: 'clean' }, 'full').route, 'read_only');
  assert.equal(routePolicy('read_only').workerMode, 'none');
});

test('trivial route is the two-agent fast path', () => {
  const policy = routePolicy('trivial');
  assert.equal(policy.workerMode, 'single_peer_review');
  assert.equal(policy.strongReview, false);
});

test('reasoning effort is selected only from model-supported values', () => {
  const model = { supportedReasoningEfforts: ['low', 'high'] };
  assert.equal(chooseReasoningEffort(model, 'low'), 'low');
  assert.equal(chooseReasoningEffort(model, 'medium'), 'low');
  assert.equal(chooseReasoningEffort(model, 'high'), 'high');
  assert.equal(chooseReasoningEffort({}, 'high'), undefined);
  assert.equal(chooseReasoningEffort(model, 'high', 'model-default'), undefined);
});
