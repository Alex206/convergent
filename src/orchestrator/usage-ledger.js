'use strict';

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

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

function aiCredits(totalNanoAiu) {
  return number(totalNanoAiu) / 1e9;
}

function taskIdFromAgent(agent) {
  const value = String(agent ?? '');
  const separator = value.indexOf(':');
  return separator > 0 ? value.slice(0, separator) : null;
}

function normalizeAgent(value = {}) {
  const entry = {
    agent: String(value.agent ?? ''),
    label: String(value.label ?? value.agent ?? ''),
    sessionId: value.sessionId,
    model: value.model ?? 'auto',
    modelId: value.modelId ?? 'auto',
    hasCreditData: Boolean(value.hasCreditData),
    contextTokens: value.contextTokens === undefined ? undefined : number(value.contextTokens),
    contextLimit: value.contextLimit === undefined ? undefined : number(value.contextLimit),
    contextMessages: value.contextMessages === undefined ? undefined : number(value.contextMessages),
    maxContextTokens: number(value.maxContextTokens),
    maxContextMessages: number(value.maxContextMessages),
  };
  for (const field of ADDITIVE_FIELDS) entry[field] = number(value[field]);
  entry.totalPremiumRequests = number(value.totalPremiumRequests);
  entry.aiCredits = aiCredits(entry.totalNanoAiu);
  return entry;
}

function addAgents(left = {}, right = {}) {
  const a = normalizeAgent(left);
  const b = normalizeAgent(right);
  const result = {
    ...a,
    ...b,
    agent: b.agent || a.agent,
    label: b.label || a.label,
    sessionId: b.sessionId ?? a.sessionId,
    model: b.model !== 'auto' ? b.model : a.model,
    modelId: b.modelId !== 'auto' ? b.modelId : a.modelId,
    hasCreditData: a.hasCreditData || b.hasCreditData,
    maxContextTokens: Math.max(a.maxContextTokens, b.maxContextTokens),
    maxContextMessages: Math.max(a.maxContextMessages, b.maxContextMessages),
    contextTokens: b.contextTokens ?? a.contextTokens,
    contextLimit: b.contextLimit ?? a.contextLimit,
    contextMessages: b.contextMessages ?? a.contextMessages,
    totalPremiumRequests: a.totalPremiumRequests + b.totalPremiumRequests,
  };
  for (const field of ADDITIVE_FIELDS) result[field] = a[field] + b[field];
  result.aiCredits = aiCredits(result.totalNanoAiu);
  return result;
}

function aggregateEntries(entries) {
  const result = {
    hasCreditData: false,
    maxContextTokens: 0,
    maxContextMessages: 0,
  };
  for (const field of ADDITIVE_FIELDS) result[field] = 0;
  for (const entry of entries) {
    for (const field of ADDITIVE_FIELDS) result[field] += number(entry[field]);
    result.hasCreditData ||= Boolean(entry.hasCreditData);
    result.maxContextTokens = Math.max(result.maxContextTokens, number(entry.maxContextTokens));
    result.maxContextMessages = Math.max(result.maxContextMessages, number(entry.maxContextMessages));
  }
  result.aiCredits = aiCredits(result.totalNanoAiu);
  return result;
}

function normalizeUsageSnapshot(value = {}) {
  const agents = Array.isArray(value.agents) ? value.agents.map(normalizeAgent).filter((item) => item.agent) : [];
  const aggregate = agents.length ? aggregateEntries(agents) : (() => {
    const root = {
      hasCreditData: Boolean(value.hasCreditData),
      maxContextTokens: number(value.maxContextTokens),
      maxContextMessages: number(value.maxContextMessages),
    };
    for (const field of ADDITIVE_FIELDS) root[field] = number(value[field]);
    root.aiCredits = aiCredits(root.totalNanoAiu);
    return root;
  })();
  return {
    version: 1,
    elapsedMs: number(value.elapsedMs),
    ...aggregate,
    agents,
  };
}

function qualifyAgentLabel(entry) {
  const taskId = taskIdFromAgent(entry.agent);
  if (!taskId) return entry;
  const prefix = `${taskId} · `;
  return {
    ...entry,
    label: String(entry.label ?? '').startsWith(prefix) ? entry.label : `${prefix}${entry.label}`,
  };
}

function mergeUsageSnapshots(baseValue, currentValue) {
  const base = normalizeUsageSnapshot(baseValue);
  const current = normalizeUsageSnapshot(currentValue);
  const map = new Map();
  for (const entry of base.agents) map.set(entry.agent, entry);
  for (const entry of current.agents) {
    map.set(entry.agent, map.has(entry.agent) ? addAgents(map.get(entry.agent), entry) : entry);
  }
  const agents = [...map.values()].map(qualifyAgentLabel);
  const totals = agents.length
    ? aggregateEntries(agents)
    : (() => {
        const root = {};
        for (const field of ADDITIVE_FIELDS) root[field] = number(base[field]) + number(current[field]);
        root.hasCreditData = Boolean(base.hasCreditData) || Boolean(current.hasCreditData);
        root.maxContextTokens = Math.max(number(base.maxContextTokens), number(current.maxContextTokens));
        root.maxContextMessages = Math.max(number(base.maxContextMessages), number(current.maxContextMessages));
        root.aiCredits = aiCredits(root.totalNanoAiu);
        return root;
      })();
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
  return {
    elapsedMs: number(base.elapsedMs) + number(current.elapsedMs),
    ...totals,
    agents,
    tasks,
    run: { ...current, tasks: undefined, run: undefined },
  };
}

function usageDelta(before = {}, after = {}) {
  const result = {};
  for (const field of ADDITIVE_FIELDS) {
    result[field] = Math.max(0, number(after[field]) - number(before[field]));
  }
  result.elapsedMs = Math.max(0, number(after.elapsedMs) - number(before.elapsedMs));
  result.maxContextTokens = number(after.maxContextTokens);
  result.maxContextMessages = number(after.maxContextMessages);
  result.hasCreditData = Boolean(after.hasCreditData) && result.totalNanoAiu > 0;
  result.aiCredits = aiCredits(result.totalNanoAiu);
  return result;
}

module.exports = {
  ADDITIVE_FIELDS,
  taskIdFromAgent,
  normalizeUsageSnapshot,
  mergeUsageSnapshots,
  usageDelta,
};