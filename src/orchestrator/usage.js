'use strict';

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function aiCreditsFromNanoAiu(totalNanoAiu) {
  return numberOrZero(totalNanoAiu) / 1e9;
}

class UsageTracker {
  constructor(startedAt = Date.now()) {
    this.startedAt = startedAt;
    this.agents = new Map();
    this.turns = 0;
  }

  register(agent, session, model, label = agent) {
    this.agents.set(agent, {
      agent,
      label,
      sessionId: session?.sessionId,
      model: model?.name ?? model?.id ?? 'auto',
      modelId: model?.id ?? 'auto',
      calls: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      premiumRequestCost: 0,
      totalNanoAiu: 0,
      hasCreditData: false,
      contextTokens: undefined,
      contextLimit: undefined,
      contextMessages: undefined,
      maxContextTokens: 0,
      maxContextMessages: 0,
      durationMs: 0,
    });
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
      entry.totalNanoAiu = numberOrZero(data.totalNanoAiu);
      entry.hasCreditData = true;
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
        entry.totalNanoAiu = numberOrZero(metrics.totalNanoAiu);
        entry.hasCreditData = true;
      }
      if (metrics?.totalPremiumRequestCost !== undefined && metrics?.totalPremiumRequestCost !== null) {
        entry.premiumRequestCost = numberOrZero(metrics.totalPremiumRequestCost);
      }
    } catch {
      // Usage RPC is experimental. Live events remain the fallback.
    }
  }

  summary(now = Date.now()) {
    const agents = [...this.agents.values()].map((entry) => ({
      ...entry,
      aiCredits: aiCreditsFromNanoAiu(entry.totalNanoAiu),
    }));
    const totalNanoAiu = agents.reduce((sum, entry) => sum + numberOrZero(entry.totalNanoAiu), 0);
    return {
      elapsedMs: Math.max(0, now - this.startedAt),
      turns: this.turns,
      calls: agents.reduce((sum, entry) => sum + entry.calls, 0),
      inputTokens: agents.reduce((sum, entry) => sum + entry.inputTokens, 0),
      outputTokens: agents.reduce((sum, entry) => sum + entry.outputTokens, 0),
      reasoningTokens: agents.reduce((sum, entry) => sum + entry.reasoningTokens, 0),
      cacheReadTokens: agents.reduce((sum, entry) => sum + entry.cacheReadTokens, 0),
      cacheWriteTokens: agents.reduce((sum, entry) => sum + entry.cacheWriteTokens, 0),
      premiumRequestCost: agents.reduce((sum, entry) => sum + entry.premiumRequestCost, 0),
      maxContextTokens: agents.reduce((max, entry) => Math.max(max, numberOrZero(entry.maxContextTokens)), 0),
      maxContextMessages: agents.reduce((max, entry) => Math.max(max, numberOrZero(entry.maxContextMessages)), 0),
      totalNanoAiu,
      aiCredits: aiCreditsFromNanoAiu(totalNanoAiu),
      hasCreditData: agents.some((entry) => entry.hasCreditData),
      agents,
    };
  }
}

module.exports = { UsageTracker, aiCreditsFromNanoAiu };
