'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SessionGuard } = require('../src/copilot/session-guard');

function fakeSession(order = []) {
  const emitter = new EventEmitter();
  const session = {
    sessionId: 'test-session',
    on(event, handler) {
      emitter.on(event, handler);
      return () => emitter.off(event, handler);
    },
    emit(event, data) { emitter.emit(event, { data }); },
    async send() {},
    async abort() { order.push('raw-abort'); },
    async disconnect() { order.push('raw-disconnect'); },
  };
  return session;
}

test('managed command progress refreshes the current tool watchdog clock', async () => {
  const session = fakeSession();
  const guard = new SessionGuard(session, 'Worker A', null, { toolStallTimeoutMs: 1_000 });
  session.emit('tool.execution_start', { toolCallId: 'tool-1', toolName: 'run_command', arguments: { command: 'node --test' } });
  const before = guard.currentTool.lastProgressAt;
  await new Promise((resolve) => setTimeout(resolve, 5));

  guard.managedCommandProgress({ commandId: 'cmd-1', phase: 'output', stream: 'stdout', bytes: 10 });

  assert.ok(guard.currentTool.lastProgressAt > before);
  assert.equal(guard.snapshot().currentTool.name, 'run_command');
  guard.dispose();
});

test('stall abort waits for managed process termination evidence before raw session abort', async () => {
  const order = [];
  const session = fakeSession(order);
  const termination = { commandId: 'cmd-1', pid: 321, proven: true, method: 'test-tree-kill' };
  const guard = new SessionGuard(session, 'Worker A', null, {
    beforeAbort: async ({ reason }) => {
      order.push(`terminate:${reason}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return termination;
    },
  });

  const evidence = await guard.forceAbortAfterStall('tool-stall');

  assert.deepEqual(order, ['terminate:tool-stall', 'raw-abort']);
  assert.deepEqual(evidence, termination);
  guard.dispose();
});

test('explicit disconnect cancels managed command before disconnecting the SDK session', async () => {
  const order = [];
  const session = fakeSession(order);
  new SessionGuard(session, 'Strong reviewer', null, {
    beforeAbort: async ({ reason }) => {
      order.push(`terminate:${reason}`);
      return { proven: true };
    },
  });

  await session.disconnect();

  assert.deepEqual(order, ['terminate:session-disconnect', 'raw-disconnect']);
});
