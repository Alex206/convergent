'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runtimeStallResumeDisposition } = require('../src/orchestrator/runtime-stall');

test('proven runtime-stall checkpoint is safe to restart with a fresh task session', () => {
  const disposition = runtimeStallResumeDisposition({
    stage: 'worker_runtime_stall',
    runtimeIncident: {
      termination: {
        active: true,
        proven: true,
        commandId: 'cmd-1',
        pid: 123,
        method: 'posix-process-group',
        groupGone: true,
      },
    },
  });

  assert.equal(disposition.runtimeStall, true);
  assert.equal(disposition.safe, true);
  assert.equal(disposition.termination.commandId, 'cmd-1');
  assert.match(disposition.reason, /proven terminated/i);
});

test('unproven runtime-stall checkpoint fails closed for resume', () => {
  const disposition = runtimeStallResumeDisposition({
    stage: 'reviewer_runtime_stall',
    runtimeIncident: {
      termination: {
        active: true,
        proven: false,
        commandId: 'cmd-2',
        pid: 456,
      },
    },
  });

  assert.equal(disposition.safe, false);
  assert.match(disposition.reason, /must not start another agent or command/i);
});

test('runtime-stall checkpoint without managed termination proof fails closed', () => {
  assert.equal(runtimeStallResumeDisposition({ stage: 'worker_runtime_stall', runtimeIncident: null }).safe, false);
  assert.equal(runtimeStallResumeDisposition({ stage: 'worker_blocked' }), null);
});
