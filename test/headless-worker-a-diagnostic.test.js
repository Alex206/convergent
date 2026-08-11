'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HeadlessWorkflowUi } = require('../src/headless/ui');

function report(verdict = 'changed') {
  return {
    verdict,
    summary: 'Implemented the dependency-ordering slice.',
    findings: [],
    checks: ['python -B -m unittest discover -s tests -v: pass'],
  };
}

test('Worker A-only diagnostic records the pass and stops before peer/reviewer work', () => {
  const events = [];
  const ui = new HeadlessWorkflowUi({
    stopAfterWorkerA: true,
    eventSink: (event) => events.push(event),
    logger: { log() {} },
  });

  assert.throws(
    () => ui.passResult('A', report(), true, 'a'.repeat(64), { durationMs: 1200, usage: { calls: 4 } }),
    (error) => error.code === 'CONVERGENT_HEADLESS_WORKER_A_DIAGNOSTIC_COMPLETE'
      && error.changed === true
      && error.revision === 'a'.repeat(64),
  );

  assert.equal(events.some((event) => event.type === 'worker_pass_result' && event.worker === 'A'), true);
  assert.equal(events.some((event) => event.type === 'headless_worker_a_diagnostic_complete' && event.worker === 'A'), true);
});

test('Worker A-only diagnostic does not stop on Worker B', () => {
  const events = [];
  const ui = new HeadlessWorkflowUi({
    stopAfterWorkerA: true,
    eventSink: (event) => events.push(event),
    logger: { log() {} },
  });

  assert.doesNotThrow(() => ui.passResult('B', report('clean'), false, 'b'.repeat(64), {}));
  assert.equal(events.some((event) => event.type === 'worker_pass_result' && event.worker === 'B'), true);
  assert.equal(events.some((event) => event.type === 'headless_worker_a_diagnostic_complete'), false);
});
