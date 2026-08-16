'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runtimeStallIncident, runtimeStallRecoveryDetail } = require('../src/orchestrator/runtime-stall');

function stallError(termination, code = 'CONVERGENT_TOOL_STALL') {
  const error = new Error('Worker A tool run_command stalled');
  error.code = code;
  error.convergentDiagnostic = {
    currentTool: { id: 'tool-1', name: 'run_command', detail: 'SECRET=must-not-leak command', durationMs: 4500, quietMs: 2000 },
    managedCommandTermination: termination,
  };
  return error;
}

test('runtime stall is recoverable only with active proven managed-command termination', () => {
  const proven = runtimeStallIncident(stallError({
    active: true,
    proven: true,
    commandId: 'cmd-1',
    pid: 123,
    method: 'posix-process-group',
    groupGone: true,
  }));
  assert.equal(proven.recoverable, true);
  assert.equal(proven.termination.commandId, 'cmd-1');

  const unproven = runtimeStallIncident(stallError({ active: true, proven: false, commandId: 'cmd-2', pid: 124 }));
  assert.equal(unproven.recoverable, false);

  const noManaged = runtimeStallIncident(stallError({ active: false, proven: true, reason: 'no-managed-command' }));
  assert.equal(noManaged.recoverable, false);
});

test('non-stall errors are not classified as runtime recovery incidents', () => {
  const error = new Error('ordinary failure');
  error.code = 'EOTHER';
  assert.equal(runtimeStallIncident(error), null);
});

test('runtime recovery detail excludes raw command text and preserves termination metadata', () => {
  const incident = runtimeStallIncident(stallError({
    active: true,
    proven: true,
    commandId: 'cmd-9',
    pid: 999,
    method: 'taskkill-tree',
    rootGone: true,
    taskkillExitCode: 0,
  }));
  const detail = runtimeStallRecoveryDetail(incident, 'REV-1');

  assert.equal(detail.workspaceFingerprint, 'REV-1');
  assert.match(detail.summary, /cmd-9/);
  assert.match(detail.summary, /999/);
  assert.match(detail.summary, /Termination proven: yes/);
  assert.doesNotMatch(detail.summary, /SECRET=must-not-leak/);
  assert.equal(detail.runtimeIncident.termination.method, 'taskkill-tree');
});
