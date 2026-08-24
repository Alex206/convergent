'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_CAPTURED_COMMAND_EVIDENCE,
  commandStartRecord,
  commandCompletionRecord,
  boundedPush,
  captureReviewerCommandEvidence,
  compactReviewerCommandEvidence,
} = require('../src/headless/reviewer-command-evidence');

function fakeSession() {
  const handlers = new Map();
  return {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => handlers.set(name, (handlers.get(name) ?? []).filter((entry) => entry !== handler));
    },
    emit(name, data) {
      for (const handler of handlers.get(name) ?? []) handler({ data });
    },
  };
}

test('command evidence captures actual managed command input/result and redacts credentials', () => {
  const start = commandStartRecord({
    data: {
      toolCallId: 'call-1',
      arguments: {
        command: 'curl -H "Authorization: Bearer supersecretvalue123" https://example.test',
        cwd: '.',
        timeoutSeconds: 10,
      },
    },
  });
  assert.equal(start.toolCallId, 'call-1');
  assert.doesNotMatch(start.command, /supersecretvalue123/);

  const completed = commandCompletionRecord(start, {
    data: {
      success: true,
      result: {
        content: JSON.stringify({
          state: 'completed',
          exitCode: 0,
          stdout: 'Authorization: Bearer anothersecretvalue456',
          stderr: '',
          elapsedMs: 42,
        }),
      },
    },
  }, 'revision-1');
  assert.equal(completed.revision, 'revision-1');
  assert.equal(completed.exit_code, 0);
  assert.doesNotMatch(completed.stdout, /anothersecretvalue456/);
});

test('captured command evidence is revision-bound and ignores non-command tools', async () => {
  const session = fakeSession();
  const sink = [];
  const capture = captureReviewerCommandEvidence(session, {
    workspace: '/workspace',
    sink,
    revisionProvider: async () => 'revision-current',
  });

  session.emit('tool.execution_start', {
    toolName: 'batch_view',
    toolCallId: 'ignored',
    arguments: {},
  });
  session.emit('tool.execution_complete', {
    toolCallId: 'ignored',
    success: true,
    result: { content: '{}' },
  });
  session.emit('tool.execution_start', {
    toolName: 'run_command',
    toolCallId: 'cmd-1',
    arguments: { command: 'python -m unittest tests.test_paths', cwd: '.', timeoutSeconds: 20 },
  });
  session.emit('tool.execution_complete', {
    toolCallId: 'cmd-1',
    success: true,
    result: {
      content: JSON.stringify({ state: 'completed', exitCode: 0, stdout: 'OK', stderr: '', elapsedMs: 12 }),
    },
  });

  await capture.flush();
  assert.equal(sink.length, 1);
  assert.equal(sink[0].revision, 'revision-current');
  assert.equal(sink[0].command, 'python -m unittest tests.test_paths');
  assert.equal(sink[0].stdout, 'OK');

  const current = compactReviewerCommandEvidence([
    { ...sink[0], revision: 'old' },
    sink[0],
  ], 'revision-current');
  assert.equal(current.length, 1);
  assert.equal(current[0].command, 'python -m unittest tests.test_paths');
  capture.dispose();
});

test('command evidence stays bounded and compact packet keeps only the newest current-revision records', () => {
  const sink = [];
  for (let index = 0; index < MAX_CAPTURED_COMMAND_EVIDENCE + 2; index += 1) {
    boundedPush(sink, {
      revision: 'current',
      command: `command-${index}`,
      stdout: `result-${index}`,
    });
  }
  assert.equal(sink.length, MAX_CAPTURED_COMMAND_EVIDENCE);
  assert.equal(sink[0].command, 'command-2');

  const compact = compactReviewerCommandEvidence(sink, 'current');
  assert.equal(compact.length, 4);
  assert.deepEqual(compact.map((entry) => entry.command), ['command-6', 'command-7', 'command-8', 'command-9']);
});
