'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PERSISTENT_COMPACTION_TURN_INTERVAL,
  REVIEWER_COMPACTION_TURN_INTERVAL,
  isReviewerAgent,
  isPersistentTaskAgent,
  compactionTurnInterval,
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

test('long-lived workers and every reviewer architecture member use proactive compaction', () => {
  assert.equal(isPersistentTaskAgent('Worker A'), true);
  assert.equal(isPersistentTaskAgent('Worker B'), true);
  assert.equal(isPersistentTaskAgent('Strong reviewer'), true);
  assert.equal(isPersistentTaskAgent('Contract & integration reviewer'), true);
  assert.equal(isPersistentTaskAgent('Adversarial & security reviewer'), true);
  assert.equal(isPersistentTaskAgent('State & resources reviewer'), true);
  assert.equal(isPersistentTaskAgent('Broad Luna reviewer 1'), true);
  assert.equal(isPersistentTaskAgent('Broad Luna reviewer 3'), true);
  assert.equal(isReviewerAgent('Coordinator'), false);
  assert.equal(isPersistentTaskAgent('Coordinator'), false);
  assert.equal(isPersistentTaskAgent('Recovery coordinator'), false);
  assert.equal(isPersistentTaskAgent('Software architect'), false);
  assert.equal(PERSISTENT_COMPACTION_TURN_INTERVAL, 2);
  assert.equal(REVIEWER_COMPACTION_TURN_INTERVAL, 1);
  assert.equal(compactionTurnInterval('Worker A'), 2);
  assert.equal(compactionTurnInterval('Contract & integration reviewer'), 1);
});

test('persistent worker send wrapper compacts before every third retained turn and keeps prompts flowing', async () => {
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
  assert.equal(compactions, 0, 'first bounded worker tranche stays verbatim');

  await wrapped({ prompt: 'turn-3' });
  assert.equal(compactions, 1, 'worker history compacts before the third persistent turn');
  await wrapped({ prompt: 'turn-4' });
  await wrapped({ prompt: 'turn-5' });
  assert.equal(compactions, 2, 'a new bounded worker tranche is retained after compaction');
  assert.deepEqual(calls, ['turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5']);
  assert.equal(audits.filter((event) => event.type === 'session_compaction_result').length, 2);
});

test('panel reviewers compact before every delta review turn', async () => {
  let compactions = 0;
  const calls = [];
  const { ui, audits } = uiFixture();
  const session = {
    sessionId: 'contract-reviewer-session',
    rpc: {
      history: {
        compact: async () => {
          compactions += 1;
          return { success: true, tokensRemoved: 250000, messagesRemoved: 30 };
        },
      },
    },
  };
  const wrapped = wrapSendAndWaitWithCompaction(
    session,
    'Contract & integration reviewer',
    ui,
    async (options) => { calls.push(options.prompt); return { ok: true }; },
  );

  await wrapped({ prompt: 'review-cycle-1' });
  assert.equal(compactions, 0);
  await wrapped({ prompt: 'review-cycle-2' });
  assert.equal(compactions, 1, 'reviewer retained history is bounded before the first delta cycle');
  await wrapped({ prompt: 'review-cycle-3' });
  assert.equal(compactions, 2, 'every later reviewer cycle starts from compacted retained history');
  assert.deepEqual(calls, ['review-cycle-1', 'review-cycle-2', 'review-cycle-3']);
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
  assert.equal(compactions, 4, 'reviewers retry compaction once per subsequent review turn, not more than once per turn');
  assert.match(logs.join('\n'), /continuing with retained history/i);
  assert.equal(audits.filter((event) => event.type === 'session_compaction_error').length, 4);
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
