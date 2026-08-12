'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HeadlessWorkflowUi } = require('../src/headless/ui');

test('plan-only diagnostic stops after an accepted Fast plan before tasks start', () => {
  const events = [];
  const ui = new HeadlessWorkflowUi({
    stopAfterPlan: true,
    eventSink: (event) => events.push(event),
    logger: { log() {} },
  });
  ui.runStarted({ version: 'test', flowMode: 'fast' });
  const plan = { tasks: [{ id: 'T1', title: 'Implement cohesive feature' }] };
  const routes = [{ route: 'standard', risk: 'medium' }];

  assert.throws(
    () => ui.plan(plan, routes),
    (error) => error.code === 'CONVERGENT_HEADLESS_PLAN_DIAGNOSTIC_COMPLETE'
      && error.plan === plan
      && error.routes === routes,
  );
  assert.equal(events.some((event) => event.type === 'plan_accepted' && event.plan === plan), true);
  assert.equal(events.some((event) => event.type === 'headless_plan_diagnostic_complete' && event.taskCount === 1), true);
  assert.equal(events.some((event) => event.type === 'task_start'), false);
});

test('Fast plan budget takes precedence over plan-only diagnostic completion', () => {
  const events = [];
  const ui = new HeadlessWorkflowUi({
    stopAfterPlan: true,
    eventSink: (event) => events.push(event),
    logger: { log() {} },
  });
  ui.runStarted({ version: 'test', flowMode: 'fast' });
  const plan = { tasks: Array.from({ length: 4 }, (_, index) => ({ id: `T${index + 1}` })) };

  assert.throws(
    () => ui.plan(plan, []),
    (error) => error.code === 'CONVERGENT_HEADLESS_PLAN_BUDGET',
  );
  assert.equal(events.some((event) => event.type === 'headless_plan_budget_exceeded'), true);
  assert.equal(events.some((event) => event.type === 'headless_plan_diagnostic_complete'), false);
});
