'use strict';

const base = require('./session-guard');

function normalizedDetail(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function toolSnapshot(tool, now = Date.now()) {
  return {
    name: tool.name,
    detail: tool.detail,
    toolCallId: tool.id,
    managedCommandId: tool.managedCommandId ?? null,
    elapsedMs: now - tool.startedAt,
    quietMs: now - tool.lastProgressAt,
    steeringSent: Boolean(tool.steeringSentAt),
    waitExtendedMs: Math.max(0, (tool.ignoreUntil || 0) - now),
    decisionPending: Boolean(tool.decisionPending),
    interactiveWait: Boolean(tool.interactiveWait),
  };
}

class ConcurrentSessionGuard extends base.SessionGuard {
  ensureActiveTools() {
    if (!(this.activeTools instanceof Map)) this.activeTools = new Map();
    if (!(this.managedCommandTools instanceof Map)) this.managedCommandTools = new Map();
    if (!Number.isInteger(this.anonymousToolSequence)) this.anonymousToolSequence = 0;
    return this.activeTools;
  }

  selectCurrentTool() {
    const tools = [...this.ensureActiveTools().values()];
    if (!tools.length) {
      this.currentTool = null;
      return null;
    }

    // Once the base watchdog has an operator decision or steering action in
    // flight for one call, keep that exact call selected until it progresses or
    // completes. Otherwise a concurrent tool could steal currentTool and make
    // the base watchdog abandon its pending decision callback.
    const pendingDecision = tools.filter((tool) => tool.decisionPending);
    const alreadySteered = tools.filter((tool) => tool.steeringSentAt);
    const nonInteractive = tools.filter((tool) => !tool.interactiveWait);
    const candidates = pendingDecision.length
      ? pendingDecision
      : alreadySteered.length
        ? alreadySteered
        : nonInteractive.length
          ? nonInteractive
          : tools;
    candidates.sort((a, b) => a.lastProgressAt - b.lastProgressAt || a.startedAt - b.startedAt);
    this.currentTool = candidates[0];
    return this.currentTool;
  }

  toolForEvent(data = {}) {
    const tools = this.ensureActiveTools();
    const id = data.toolCallId;
    if (id && tools.has(id)) return tools.get(id);
    const name = String(data.toolName ?? '').trim();
    if (name) {
      const matching = [...tools.values()].filter((tool) => tool.name === name);
      if (matching.length === 1) return matching[0];
    }
    if (tools.size === 1) return tools.values().next().value;
    return null;
  }

  managedToolForProgress(detail = {}) {
    this.ensureActiveTools();
    const commandId = String(detail.commandId ?? '').trim();
    if (commandId && this.managedCommandTools.has(commandId)) {
      return this.managedCommandTools.get(commandId);
    }

    let candidates = [...this.activeTools.values()]
      .filter((tool) => /run[_-]?command$/i.test(tool.name) && !tool.managedCommandId);

    // SDK tool events expose the original command text while the managed
    // runtime exposes it as displayCommand. Match those first so two concurrent
    // run_command calls cannot swap command IDs merely because their runtime
    // start callbacks arrive in a different order.
    const displayCommand = normalizedDetail(detail.displayCommand);
    if (displayCommand) {
      const exact = candidates.filter((tool) => normalizedDetail(tool.detail) === displayCommand);
      if (exact.length === 1) candidates = exact;
    }

    candidates.sort((a, b) => b.startedAt - a.startedAt);
    const tool = candidates[0] ?? null;
    if (tool && commandId) {
      tool.managedCommandId = commandId;
      this.managedCommandTools.set(commandId, tool);
    }
    return tool;
  }

  releaseManagedTool(tool) {
    if (!tool?.managedCommandId) return;
    this.managedCommandTools.delete(tool.managedCommandId);
  }

  attachEvents() {
    this.ensureActiveTools();
    const on = (eventName, handler) => {
      try {
        const dispose = this.session.on(eventName, handler);
        if (dispose) this.disposers.push(dispose);
      } catch {
        // Older compatible runtimes may not expose every optional event.
      }
    };

    on('tool.execution_start', (event) => {
      const data = event?.data ?? {};
      const now = Date.now();
      const id = data.toolCallId ?? `anonymous-${++this.anonymousToolSequence}`;
      const tool = {
        id,
        name: data.toolName ?? 'unknown',
        detail: base.describeToolCall(data),
        startedAt: now,
        lastProgressAt: now,
        steeringSentAt: 0,
        ignoreUntil: 0,
        decisionPending: false,
        interactiveWait: base.isInteractiveUserTool(data.toolName),
        managedCommandId: null,
      };
      this.activeTools.set(id, tool);
      this.selectCurrentTool();
      this.touch();
    });

    const progress = (event) => {
      const tool = this.toolForEvent(event?.data ?? {});
      if (tool) {
        tool.lastProgressAt = Date.now();
        tool.steeringSentAt = 0;
        tool.ignoreUntil = 0;
        tool.decisionPending = false;
        this.selectCurrentTool();
      }
      this.touch();
    };
    on('tool.execution_progress', progress);
    on('tool.execution_partial_result', progress);

    on('tool.execution_complete', (event) => {
      const data = event?.data ?? {};
      const now = Date.now();
      const tool = this.toolForEvent(data);
      if (tool) {
        const durationMs = now - tool.startedAt;
        const stats = this.toolStats.get(tool.name) ?? { calls: 0, totalMs: 0, maxMs: 0, failures: 0 };
        stats.calls += 1;
        stats.totalMs += durationMs;
        stats.maxMs = Math.max(stats.maxMs, durationMs);
        if (data.success === false) stats.failures += 1;
        this.toolStats.set(tool.name, stats);
        this.ui?.agentToolComplete?.(this.agentName, tool.name, durationMs, data.success !== false);
        this.releaseManagedTool(tool);
        this.activeTools.delete(tool.id);
        this.selectCurrentTool();
      }
      this.touch();
    });

    for (const eventName of [
      'assistant.intent',
      'assistant.message',
      'assistant.message_delta',
      'assistant.usage',
      'session.usage_checkpoint',
      'session.usage_info',
      'session.idle',
      'session.error',
    ]) {
      on(eventName, () => this.touch());
    }
  }

  managedCommandProgress(detail = {}) {
    const now = Date.now();
    const tool = this.managedToolForProgress(detail);
    if (tool) {
      if (detail.phase === 'started' && detail.displayCommand) {
        tool.detail = normalizedDetail(detail.displayCommand);
      }
      tool.lastProgressAt = now;
      tool.steeringSentAt = 0;
      tool.ignoreUntil = 0;
      tool.decisionPending = false;
      this.selectCurrentTool();
    }
    this.lastActivityAt = now;
    this.inactivitySteeringSentAt = 0;
    this.inactivityIgnoreUntil = 0;
    this.inactivityDecisionPending = false;
    this.ui?.agentManagedCommandProgress?.(this.agentName, detail);
  }

  snapshot() {
    const snapshot = base.SessionGuard.prototype.snapshot.call(this);
    const now = Date.now();
    return {
      ...snapshot,
      activeTools: [...this.ensureActiveTools().values()]
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((tool) => toolSnapshot(tool, now)),
    };
  }

  dispose() {
    this.ensureActiveTools().clear();
    this.managedCommandTools.clear();
    this.currentTool = null;
    return base.SessionGuard.prototype.dispose.call(this);
  }
}

function guardSession(session, agentName, ui, options = {}) {
  return new ConcurrentSessionGuard(session, agentName, ui, options);
}

module.exports = {
  ...base,
  SessionGuard: ConcurrentSessionGuard,
  guardSession,
  toolSnapshot,
  normalizedDetail,
};
