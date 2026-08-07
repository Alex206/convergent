'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTaskRoute,
  routePolicy,
  chooseReasoningEffort,
  isClearlyTrivialChange,
} = require('../src/orchestrator/routing');

test('high-risk modifying tasks cannot use a lighter route', () => {
  const routing = normalizeTaskRoute({ route: 'trivial', risk: 'high', routingReason: 'small diff' });
  assert.equal(routing.route, 'high_risk');
  assert.equal(routing.overridden, true);
});

test('medium-risk trivial tasks are upgraded to standard', () => {
  assert.equal(normalizeTaskRoute({ route: 'trivial', risk: 'medium' }).route, 'standard');
});

test('full routing mode forces modifying trivial tasks through full review', () => {
  assert.equal(normalizeTaskRoute({
    route: 'trivial',
    risk: 'low',
    title: 'README wording',
    description: 'Change README documentation wording.',
    acceptanceCriteria: ['README text is updated'],
  }, 'full').route, 'standard');
});

test('read-only tasks remain coordinator-only even in full mode', () => {
  assert.equal(normalizeTaskRoute({ route: 'read_only', risk: 'low', result: 'clean' }, 'full').route, 'read_only');
  assert.equal(routePolicy('read_only').workerMode, 'none');
});

test('trivial route remains available for clearly documentation-only edits', () => {
  const task = {
    route: 'trivial',
    risk: 'low',
    title: 'README Purpose wording',
    description: 'Add a short Markdown Purpose section to README.md.',
    acceptanceCriteria: ['README documentation contains the requested text'],
  };
  assert.equal(isClearlyTrivialChange(task), true);
  assert.equal(normalizeTaskRoute(task).route, 'trivial');
  const policy = routePolicy('trivial');
  assert.equal(policy.workerMode, 'single_peer_review');
  assert.equal(policy.strongReview, false);
});

test('creating executable source and unit tests is standard even if coordinator says trivial', () => {
  const routing = normalizeTaskRoute({
    route: 'trivial',
    risk: 'low',
    title: 'Add Python hello-world script and test',
    description: 'Create hello_world.py, a unit test, and README instructions.',
    acceptanceCriteria: ['Python script runs', 'Unit test passes', 'README is updated'],
  });
  assert.equal(routing.route, 'standard');
  assert.equal(routing.overridden, true);
  assert.match(routing.reason, /trivial fast path is reserved/);
});

test('security semantics force high-risk treatment even if coordinator underrates risk', () => {
  const routing = normalizeTaskRoute({
    route: 'standard',
    risk: 'low',
    title: 'Change authentication token handling',
    description: 'Modify credential validation.',
    acceptanceCriteria: ['Authentication works'],
  });
  assert.equal(routing.risk, 'high');
  assert.equal(routing.route, 'high_risk');
});

test('strong reviewer effort scales with task risk without changing reviewer model', () => {
  assert.equal(routePolicy('standard', 'low').efforts.reviewer, 'low');
  assert.equal(routePolicy('standard', 'medium').efforts.reviewer, 'medium');
  assert.equal(routePolicy('standard', 'high').efforts.reviewer, 'medium');
  assert.equal(routePolicy('high_risk', 'high').efforts.reviewer, 'high');
});

test('reasoning effort is selected only from model-supported values', () => {
  const model = { supportedReasoningEfforts: ['low', 'high'] };
  assert.equal(chooseReasoningEffort(model, 'low'), 'low');
  assert.equal(chooseReasoningEffort(model, 'medium'), 'low');
  assert.equal(chooseReasoningEffort(model, 'high'), 'high');
  assert.equal(chooseReasoningEffort({}, 'high'), undefined);
  assert.equal(chooseReasoningEffort(model, 'high', 'model-default'), undefined);
});
