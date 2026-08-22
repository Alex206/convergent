'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PERSISTENT_COMPACTION_TURN_INTERVAL,
  isPersistentTaskAgent,
  compactSessionHistory,
  wrapSendAndWaitWithCompaction,
} = require('../src/copilot/session-compaction');

function uiFixture() {
  const logs = [];
  const audits = [];
  return {
    ui: {
      log: (message) => logs.push(message),
      audit: (event) => audits.push(event),
    },
    logs,
    audits,
  };
}

test('only long-lived task workers and the strong reviewer use proactive compaction', () => {
  assert.equal(isPersistentTaskAgent('Worker A'), true);
  assert.equal(isPersistentTaskAgent('Worker B'), true);
  assert.equal(isPersistentTaskAgent('Strong reviewer'), true);
  assert.equal(isPersistentTaskAgent('Coordinator'), false);
  assert.equal(isPersistentTaskAgent('Recovery coordinator'), false);
  assert.equal(isPersistentTaskAgent('Software architect'), false);
  assert.equal(PERSISTENT_COMPACTION_TURN_INTERVAL, 2);
});

test('persistent send wrapper compacts before every third retained turn and keeps prompts flowing', async () => {
  const calls = [];
  let compactions = 0;
  const { ui, audits } = uiFixture();
  const session = {
    sessionId: 'worker-a-session',
    rpc: {
      history: {
        compact: async () => {
          compactions += 1;
          return { success: true, tokensRemoved: 42000, messagesRemoved: 12 };
        },
      },
    },
  };
  const wrapped = wrapSendAndWaitWithCompaction(
    session,
    'Worker A',
    ui,
    async (options) => { calls.push(options.prompt); return { ok: true }; },
  );

  await wrapped({ prompt: 'turn-1' });
  await wrapped({ prompt: 'turn-2' });
  assert.equal(compactions, 0, 'first bounded tranche stays verbatim');

  await wrapped({ prompt: 'turn-3' });
  assert.equal(compactions, 1, 'history compacts before the third persistent turn');
  await wrapped({ prompt: 'turn-4' });
  await wrapped({ prompt: 'turn-5' });
  assert.equal(compactions, 2, 'a new bounded tranche is retained after compaction');
  assert.deepEqual(calls, ['turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5']);
  assert.equal(audits.filter((event) => event.type === 'session_compaction_result').length, 2);
});

test('coordinator-style sessions are not proactively compacted by the wrapper', async () => {
  let compactions = 0;
  const session = {
    sessionId: 'coordinator-session',
    rpc: { history: { compact: async () => { compactions += 1; return { success: true }; } } },
  };
  const wrapped = wrapSendAndWaitWithCompaction(session, 'Coordinator', {}, async () => ({ ok: true }));
  for (let index = 0; index < 6; index += 1) await wrapped({ prompt: `turn-${index}` });
  assert.equal(compactions, 0);
});

test('compaction is fail-open and bounded when the runtime rejects the RPC', async () => {
  let sends = 0;
  let compactions = 0;
  const { ui, logs, audits } = uiFixture();
  const session = {
    sessionId: 'reviewer-session',
    rpc: {
      history: {
        compact: async () => {
          compactions += 1;
          throw new Error('compact unavailable');
        },
      },
    },
  };
  const wrapped = wrapSendAndWaitWithCompaction(session, 'Strong reviewer', ui, async () => { sends += 1; return {}; });

  for (let index = 0; index < 5; index += 1) await wrapped({ prompt: `review-${index}` });
  assert.equal(sends, 5);
  assert.equal(compactions, 2, 'failure does not cause an RPC attempt on every subsequent turn');
  assert.match(logs.join('\n'), /continuing with retained history/i);
  assert.equal(audits.filter((event) => event.type === 'session_compaction_error').length, 2);
});

test('manual compaction reports removed context and treats missing RPC as unavailable', async () => {
  const successful = uiFixture();
  const result = await compactSessionHistory({
    sessionId: 's1',
    rpc: { history: { compact: async () => ({ success: true, tokensRemoved: 1234, messagesRemoved: 9 }) } },
  }, 'Worker B', successful.ui);
  assert.deepEqual(result, { attempted: true, success: true, tokensRemoved: 1234, messagesRemoved: 9, error: null });
  assert.match(successful.logs[0], /1234 token\(s\), 9 message\(s\) removed/);

  const unavailable = uiFixture();
  const missing = await compactSessionHistory({ sessionId: 's2' }, 'Worker A', unavailable.ui);
  assert.equal(missing.unavailable, true);
  assert.match(unavailable.logs[0], /unavailable/i);
});
