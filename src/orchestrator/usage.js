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

  register(agent, session, model) {
    const existing = this.agents.get(agent) ?? {};
    this.agents.set(agent, {
      agent,
      sessionId: session?.sessionId ?? existing.sessionId,
      model: model?.name ?? model?.id ?? existing.model ?? 'auto',
      modelId: model?.id ?? existing.modelId ?? 'auto',
      calls: existing.calls ?? 0,
      turns: existing.turns ?? 0,
      inputTokens: existing.inputTokens ?? 0,
      outputTokens: existing.outputTokens ?? 0,
      premiumRequestCost: existing.premiumRequestCost ?? 0,
      totalNanoAiu: existing.totalNanoAiu ?? 0,
      hasCreditData: existing.hasCreditData ?? false,
      contextTokens: existing.contextTokens,
      contextLimit: existing.contextLimit,
      durationMs: existing.durationMs ?? 0,
    });
  }

  recordAssistantUsage(agent, data = {}) {
    const entry = this.agents.get(agent);
    if (!entry) return;
    entry.calls += 1;
    entry.inputTokens += numberOrZero(data.inputTokens);
    entry.outputTokens += numberOrZero(data.outputTokens);
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
      premiumRequestCost: agents.reduce((sum, entry) => sum + entry.premiumRequestCost, 0),
      totalNanoAiu,
      aiCredits: aiCreditsFromNanoAiu(totalNanoAiu),
      hasCreditData: agents.some((entry) => entry.hasCreditData),
      agents,
    };
  }
}

module.exports = { UsageTracker, aiCreditsFromNanoAiu };
