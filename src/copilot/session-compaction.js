'use strict';

const PERSISTENT_COMPACTION_TURN_INTERVAL = 2;
const REVIEWER_COMPACTION_TURN_INTERVAL = 1;

function isReviewerAgent(agentName) {
  const name = String(agentName ?? '').trim();
  return name === 'Strong reviewer' || /reviewer(?:\s+\d+)?$/i.test(name);
}

function isPersistentTaskAgent(agentName) {
  const name = String(agentName ?? '');
  return /^Worker [AB]$/.test(name) || isReviewerAgent(name);
}

function compactionTurnInterval(agentName, requestedInterval = null) {
  if (requestedInterval !== null && requestedInterval !== undefined) {
    return Math.max(1, Math.trunc(Number(requestedInterval) || PERSISTENT_COMPACTION_TURN_INTERVAL));
  }
  return isReviewerAgent(agentName)
    ? REVIEWER_COMPACTION_TURN_INTERVAL
    : PERSISTENT_COMPACTION_TURN_INTERVAL;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

async function compactSessionHistory(session, agentName, ui) {
  const compact = session?.rpc?.history?.compact;
  if (typeof compact !== 'function') {
    ui?.log?.(`${agentName} session history compaction is unavailable in the active Copilot runtime; continuing without compaction.`);
    ui?.audit?.({ type: 'session_compaction_unavailable', agent: agentName, sessionId: session?.sessionId ?? null });
    return { attempted: false, success: false, unavailable: true };
  }

  try {
    const result = await compact.call(session.rpc.history);
    const success = result?.success !== false;
    const tokensRemoved = numberOrZero(result?.tokensRemoved);
    const messagesRemoved = numberOrZero(result?.messagesRemoved);
    const outcome = success
      ? `${tokensRemoved} token(s), ${messagesRemoved} message(s) removed`
      : `runtime reported failure${result?.error ? `: ${result.error}` : ''}`;
    ui?.log?.(`${agentName} compacted retained Copilot history before session reuse: ${outcome}.`);
    ui?.audit?.({
      type: 'session_compaction_result',
      agent: agentName,
      sessionId: session?.sessionId ?? null,
      success,
      tokensRemoved,
      messagesRemoved,
      error: result?.error ?? null,
    });
    return { attempted: true, success, tokensRemoved, messagesRemoved, error: result?.error ?? null };
  } catch (error) {
    const message = error?.message ?? String(error);
    ui?.log?.(`${agentName} session history compaction failed; continuing with retained history: ${message}`);
    ui?.audit?.({ type: 'session_compaction_error', agent: agentName, sessionId: session?.sessionId ?? null, message });
    return { attempted: true, success: false, error: message };
  }
}

function wrapSendAndWaitWithCompaction(session, agentName, ui, sendAndWait, {
  interval = null,
  onPrompt = null,
} = {}) {
  if (typeof sendAndWait !== 'function') throw new Error('wrapSendAndWaitWithCompaction requires sendAndWait.');
  const boundedInterval = compactionTurnInterval(agentName, interval);
  let completedSinceCompaction = 0;

  return async (options, timeoutMs) => {
    if (isPersistentTaskAgent(agentName) && completedSinceCompaction >= boundedInterval) {
      await compactSessionHistory(session, agentName, ui);
      // Whether compaction succeeds or not, avoid hammering an unavailable/failing
      // runtime on every subsequent turn. Retry only after another bounded tranche.
      completedSinceCompaction = 0;
    }

    onPrompt?.(options);
    try {
      return await sendAndWait(options, timeoutMs);
    } finally {
      completedSinceCompaction += 1;
    }
  };
}

module.exports = {
  PERSISTENT_COMPACTION_TURN_INTERVAL,
  REVIEWER_COMPACTION_TURN_INTERVAL,
  isReviewerAgent,
  isPersistentTaskAgent,
  compactionTurnInterval,
  compactSessionHistory,
  wrapSendAndWaitWithCompaction,
};
