'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionGuard, settleWithin } = require('../src/copilot/session-guard');

function fakeSession({ sendAndWait, abort, disconnect, send } = {}) {
  const handlers = new Map();
  return {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => handlers.set(name, (handlers.get(name) ?? []).filter((item) => item !== handler));
    },
    emit(name, data) {
      for (const handler of handlers.get(name) ?? []) handler({ data });
    },
    sendAndWait: sendAndWait ?? (async () => ({ data: { content: 'done' } })),
    send: send ?? (async () => {}),
    abort: abort ?? (async () => {}),
    disconnect: disconnect ?? (async () => {}),
  };
}

function fakeUi() {
  return new Proxy({}, { get: () => () => {} });
}

test('settleWithin reports an operation that does not settle', async () => {
  const result = await settleWithin(new Promise(() => {}), 15);
  assert.equal(result.settled, false);
});

test('wrapped abort rejects a pending guarded send even when SDK abort never settles', async () => {
  const session = fakeSession({
    sendAndWait: async () => new Promise(() => {}),
    abort: async () => new Promise(() => {}),
  });
  new SessionGuard(session, 'Worker A', fakeUi(), { controlTimeoutMs: 20, heartbeatMs: 60_000 });

  const pending = session.sendAndWait({ prompt: 'work' }, 180_000);
  const rejected = assert.rejects(pending, (error) => error.code === 'CONVERGENT_CANCELLED');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const startedAt = Date.now();
  await session.abort();
  assert.ok(Date.now() - startedAt < 1000, 'bounded abort should return promptly');
  await rejected;
});

test('guard records tool completion timing and current tool diagnostics', async () => {
  const session = fakeSession();
  const guard = new SessionGuard(session, 'Worker B', fakeUi(), { heartbeatMs: 60_000 });

  session.emit('tool.execution_start', { toolCallId: 'tool-1', toolName: 'powershell' });
  let snapshot = guard.snapshot();
  assert.equal(snapshot.currentTool.name, 'powershell');
  assert.equal(snapshot.currentTool.toolCallId, 'tool-1');

  session.emit('tool.execution_progress', { toolCallId: 'tool-1', progressMessage: 'running' });
  session.emit('tool.execution_complete', { toolCallId: 'tool-1', success: true });
  snapshot = guard.snapshot();
  assert.equal(snapshot.currentTool, null);
  assert.equal(snapshot.tools[0].name, 'powershell');
  assert.equal(snapshot.tools[0].calls, 1);
  assert.equal(snapshot.tools[0].failures, 0);
});

test('wrapped disconnect is bounded when SDK disconnect never settles', async () => {
  const session = fakeSession({ disconnect: async () => new Promise(() => {}) });
  new SessionGuard(session, 'Coordinator', fakeUi(), { controlTimeoutMs: 20, heartbeatMs: 60_000 });
  const startedAt = Date.now();
  await session.disconnect();
  assert.ok(Date.now() - startedAt < 1000, 'bounded disconnect should return promptly');
});
