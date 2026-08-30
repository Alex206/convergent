'use strict';

const USAGE_STATE_VERSION = 1;
const ADDITIVE_FIELDS = [
  'calls',
  'turns',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'premiumRequestCost',
  'totalNanoAiu',
  'durationMs',
];

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function aiCreditsFromNanoAiu(totalNanoAiu) {
  return numberOrZero(totalNanoAiu) / 1e9;
}

function emptyTotals() {
  return Object.fromEntries(ADDITIVE_FIELDS.map((field) => [field, 0]));
}

function sanitizeAgent(entry = {}) {
  return {
    agent: String(entry.agent ?? ''),
    label: String(entry.label ?? entry.agent ?? ''),
    sessionId: entry.sessionId,
    model: entry.model ?? 'auto',
    modelId: entry.modelId ?? 'auto',
    calls: numberOrZero(entry.calls),
    turns: numberOrZero(entry.turns),
    inputTokens: numberOrZero(entry.inputTokens),
    outputTokens: numberOrZero(entry.outputTokens),
    reasoningTokens: numberOrZero(entry.reasoningTokens),
    cacheReadTokens: numberOrZero(entry.cacheReadTokens),
    cacheWriteTokens: numberOrZero(entry.cacheWriteTokens),
    premiumRequestCost: numberOrZero(entry.premiumRequestCost),
    totalPremiumRequests: numberOrZero(entry.totalPremiumRequests),
    totalNanoAiu: numberOrZero(entry.totalNanoAiu),
    hasCreditData: Boolean(entry.hasCreditData),
    contextTokens: entry.contextTokens === undefined ? undefined : numberOrZero(entry.contextTokens),
    contextLimit: entry.contextLimit === undefined ? undefined : numberOrZero(entry.contextLimit),
    contextMessages: entry.contextMessages === undefined ? undefined : numberOrZero(entry.contextMessages),
    maxContextTokens: numberOrZero(entry.maxContextTokens),
    maxContextMessages: numberOrZero(entry.maxContextMessages),
    durationMs: numberOrZero(entry.durationMs),
  };
}

function taskIdFromAgent(agent) {
  const value = String(agent ?? '');
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  return value.slice(0, separator);
}

function aggregateEntries(entries) {
  const totals = emptyTotals();
  let maxContextTokens = 0;
  let maxContextMessages = 0;
  let hasCreditData = false;
  for (const entry of entries) {
    for (const field of ADDITIVE_FIELDS) totals[field] += numberOrZero(entry[field]);
    maxContextTokens = Math.max(maxContextTokens, numberOrZero(entry.maxContextTokens));
    maxContextMessages = Math.max(maxContextMessages, numberOrZero(entry.maxContextMessages));
    hasCreditData ||= Boolean(entry.hasCreditData);
  }
  return {
    ...totals,
    maxContextTokens,
    maxContextMessages,
    aiCredits: aiCreditsFromNanoAiu(totals.totalNanoAiu),
    hasCreditData,
  };
}

function subtractTotals(current, baseline, { hasCreditData = false } = {}) {
  const result = {};
  for (const field of ADDITIVE_FIELDS) {
    result[field] = Math.max(0, numberOrZero(current?.[field]) - numberOrZero(baseline?.[field]));
  }
  return {
    ...result,
    maxContextTokens: numberOrZero(current?.maxContextTokens),
    maxContextMessages: numberOrZero(current?.maxContextMessages),
    aiCredits: aiCreditsFromNanoAiu(result.totalNanoAiu),
    hasCreditData,
  };
}

function usageDelta(before = {}, after = {}) {
  const delta = subtractTotals(after, before, {
    hasCreditData: Boolean(after.hasCreditData) && numberOrZero(after.totalNanoAiu) >= numberOrZero(before.totalNanoAiu),
  });
  delta.elapsedMs = Math.max(0, numberOrZero(after.elapsedMs) - numberOrZero(before.elapsedMs));
  return delta;
}

class UsageTracker {
  constructor(startedAt = Date.now()) {
    this.startedAt = startedAt;
    this.runStartedAt = Date.now();
    this.agents = new Map();
    this.turns = 0;
    this.runBaseline = emptyTotals();
    this.runHasCreditData = false;
  }

  register(agent, session, model, label = agent) {
    const existing = this.agents.get(agent);
    const entry = existing ?? sanitizeAgent({ agent, label });
    entry.agent = agent;
    entry.label = label;
    entry.sessionId = session?.sessionId;
    entry.model = model?.name ?? model?.id ?? entry.model ?? 'auto';
    entry.modelId = model?.id ?? entry.modelId ?? 'auto';
    entry._sessionNanoAiuBase = numberOrZero(entry.totalNanoAiu);
    entry._sessionPremiumCostBase = numberOrZero(entry.premiumRequestCost);
    entry._lastSessionNanoAiu = 0;
    entry._lastSessionPremiumCost = 0;
    this.agents.set(agent, entry);
  }

  recordAssistantUsage(agent, data = {}) {
    const entry = this.agents.get(agent);
    if (!entry) return;
    entry.calls += 1;
    entry.inputTokens += numberOrZero(data.inputTokens);
    entry.outputTokens += numberOrZero(data.outputTokens);
    entry.reasoningTokens += numberOrZero(data.reasoningTokens);
    entry.cacheReadTokens += numberOrZero(data.cacheReadTokens);
    entry.cacheWriteTokens += numberOrZero(data.cacheWriteTokens);
    entry.premiumRequestCost += numberOrZero(data.cost);
  }

  recordCheckpoint(agent, data = {}) {
    const entry = this.agents.get(agent);
    if (!entry) return;
    if (data.totalNanoAiu !== undefined && data.totalNanoAiu !== null) {
      const reported = Math.max(0, numberOrZero(data.totalNanoAiu));
      entry._sessionNanoAiuBase ??= numberOrZero(entry.totalNanoAiu);
      entry.totalNanoAiu = entry._sessionNanoAiuBase + reported;
      entry._lastSessionNanoAiu = reported;
      entry.hasCreditData = true;
      this.runHasCreditData = true;
    }
    if (data.totalPremiumRequests !== undefined && data.totalPremiumRequests !== null) {
      entry.totalPremiumRequests = numberOrZero(data.totalPremiumRequests);
    }
  }

  recordContext(agent, data = {}) {
    const entry = this.agents.get(agent);
    if (!entry) return;
    entry.contextTokens = numberOrZero(data.currentTokens);
    entry.contextLimit = numberOrZero(data.tokenLimit);
    entry.contextMessages = numberOrZero(data.messagesLength ?? data.messageCount);
    entry.maxContextTokens = Math.max(entry.maxContextTokens, entry.contextTokens);
    entry.maxContextMessages = Math.max(entry.maxContextMessages, entry.contextMessages);
  }

  recordTurn(agent, durationMs) {
    const entry = this.agents.get(agent);
    if (!entry) return;
    entry.turns += 1;
    entry.durationMs += Math.max(0, numberOrZero(durationMs));
    this.turns += 1;
  }

  async refresh(agent, session) {
    const entry = this.agents.get(agent);
    const getMetrics = session?.rpc?.usage?.getMetrics;
    if (!entry || typeof getMetrics !== 'function') return;
    try {
      const metrics = await getMetrics.call(session.rpc.usage);
      if (metrics?.totalNanoAiu !== undefined && metrics?.totalNanoAiu !== null) {
        const reported = Math.max(0, numberOrZero(metrics.totalNanoAiu));
        entry._sessionNanoAiuBase ??= numberOrZero(entry.totalNanoAiu);
        entry.totalNanoAiu = entry._sessionNanoAiuBase + reported;
        entry._lastSessionNanoAiu = reported;
        entry.hasCreditData = true;
        this.runHasCreditData = true;
      }
      if (metrics?.totalPremiumRequestCost !== undefined && metrics?.totalPremiumRequestCost !== null) {
        const reported = Math.max(0, numberOrZero(metrics.totalPremiumRequestCost));
        entry._sessionPremiumCostBase ??= numberOrZero(entry.premiumRequestCost);
        entry.premiumRequestCost = entry._sessionPremiumCostBase + reported;
        entry._lastSessionPremiumCost = reported;
      }
    } catch {
      // Usage RPC is experimental. Live events remain the fallback.
    }
  }

  exportState() {
    return {
      version: USAGE_STATE_VERSION,
      startedAt: this.startedAt,
      turns: this.turns,
      agents: [...this.agents.values()].map(sanitizeAgent),
    };
  }

  restore(state) {
    if (!state || state.version !== USAGE_STATE_VERSION || !Array.isArray(state.agents)) return false;
    const startedAt = Number(state.startedAt);
    if (Number.isFinite(startedAt) && startedAt > 0) this.startedAt = startedAt;
    this.turns = Math.max(0, numberOrZero(state.turns));
    this.agents = new Map();
    for (const raw of state.agents) {
      const entry = sanitizeAgent(raw);
      if (!entry.agent) continue;
      entry._sessionNanoAiuBase = entry.totalNanoAiu;
      entry._sessionPremiumCostBase = entry.premiumRequestCost;
      entry._lastSessionNanoAiu = 0;
      entry._lastSessionPremiumCost = 0;
      this.agents.set(entry.agent, entry);
    }
    const totals = aggregateEntries([...this.agents.values()]);
    this.runBaseline = Object.fromEntries(ADDITIVE_FIELDS.map((field) => [field, numberOrZero(totals[field])]));
    this.runStartedAt = Date.now();
    this.runHasCreditData = false;
    return true;
  }

  summary(now = Date.now()) {
    const agents = [...this.agents.values()].map((entry) => ({
      ...sanitizeAgent(entry),
      aiCredits: aiCreditsFromNanoAiu(entry.totalNanoAiu),
    }));
    const totals = aggregateEntries(agents);
    const taskGroups = new Map();
    for (const entry of agents) {
      const taskId = taskIdFromAgent(entry.agent);
      if (!taskId) continue;
      const group = taskGroups.get(taskId) ?? [];
      group.push(entry);
      taskGroups.set(taskId, group);
    }
    const tasks = [...taskGroups.entries()].map(([taskId, entries]) => ({
      taskId,
      ...aggregateEntries(entries),
      agents: entries,
    }));
    const run = subtractTotals(totals, this.runBaseline, { hasCreditData: this.runHasCreditData });
    run.elapsedMs = Math.max(0, now - this.runStartedAt);

    return {
      elapsedMs: Math.max(0, now - this.startedAt),
      runElapsedMs: run.elapsedMs,
      ...totals,
      turns: totals.turns,
      agents,
      tasks,
      run,
    };
  }
}

module.exports = {
  UsageTracker,
  aiCreditsFromNanoAiu,
  usageDelta,
  USAGE_STATE_VERSION,
  taskIdFromAgent,
};