'use strict';

const DEFAULT_TOOL_STALL_TIMEOUT_MS = 120_000;
const DEFAULT_STALL_GRACE_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleWithin(value, timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS) {
  if (!value || typeof value.then !== 'function') return { settled: true };
  const marker = Symbol('timeout');
  try {
    const result = await Promise.race([
      value,
      delay(timeoutMs).then(() => marker),
    ]);
    return result === marker ? { settled: false } : { settled: true, result };
  } catch (error) {
    return { settled: true, error };
  }
}

function makeControlError(message, code, diagnostic) {
  const error = new Error(message);
  error.code = code;
  error.convergentDiagnostic = diagnostic;
  return error;
}

class SessionGuard {
  constructor(session, agentName, ui, options = {}) {
    this.session = session;
    this.agentName = agentName;
    this.ui = ui;
    this.toolStallTimeoutMs = Math.max(1_000, Number(options.toolStallTimeoutMs) || DEFAULT_TOOL_STALL_TIMEOUT_MS);
    this.stallGraceMs = Math.max(1_000, Number(options.stallGraceMs) || DEFAULT_STALL_GRACE_MS);
    this.heartbeatMs = Math.max(1_000, Number(options.heartbeatMs) || DEFAULT_HEARTBEAT_MS);
    this.controlTimeoutMs = Math.max(250, Number(options.controlTimeoutMs) || DEFAULT_CONTROL_TIMEOUT_MS);

    this.currentTool = null;
    this.toolStats = new Map();
    this.stalls = [];
    this.startedAt = Date.now();
    this.lastActivityAt = this.startedAt;
    this.lastHeartbeatAt = 0;
    this.activeRejectors = new Set();
    this.disposers = [];

    this.rawSendAndWait = session.sendAndWait.bind(session);
    this.rawSend = typeof session.send === 'function' ? session.send.bind(session) : null;
    this.rawAbort = typeof session.abort === 'function' ? session.abort.bind(session) : null;
    this.rawDisconnect = typeof session.disconnect === 'function' ? session.disconnect.bind(session) : null;

    this.attachEvents();
    this.wrapControlMethods();
    session.__convergentGuard = this;
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  attachEvents() {
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
      this.currentTool = {
        id: data.toolCallId ?? 'unknown',
        name: data.toolName ?? 'unknown',
        startedAt: now,
        lastProgressAt: now,
        steeringSentAt: 0,
      };
      this.touch();
    });

    const progress = (event) => {
      const id = event?.data?.toolCallId;
      if (this.currentTool && (!id || id === this.currentTool.id)) {
        this.currentTool.lastProgressAt = Date.now();
        this.currentTool.steeringSentAt = 0;
      }
      this.touch();
    };
    on('tool.execution_progress', progress);
    on('tool.execution_partial_result', progress);

    on('tool.execution_complete', (event) => {
      const data = event?.data ?? {};
      const now = Date.now();
      if (this.currentTool && (!data.toolCallId || data.toolCallId === this.currentTool.id)) {
        const durationMs = now - this.currentTool.startedAt;
        const stats = this.toolStats.get(this.currentTool.name) ?? { calls: 0, totalMs: 0, maxMs: 0, failures: 0 };
        stats.calls += 1;
        stats.totalMs += durationMs;
        stats.maxMs = Math.max(stats.maxMs, durationMs);
        if (data.success === false) stats.failures += 1;
        this.toolStats.set(this.currentTool.name, stats);
        this.ui?.agentToolComplete?.(this.agentName, this.currentTool.name, durationMs, data.success !== false);
        this.currentTool = null;
      }
      this.touch();
    });

    for (const eventName of ['assistant.intent', 'assistant.message', 'assistant.usage', 'session.usage_checkpoint', 'session.idle', 'session.error']) {
      on(eventName, () => this.touch());
    }
  }

  wrapControlMethods() {
    this.session.sendAndWait = (options, timeoutMs) => this.guardedSendAndWait(options, timeoutMs);

    if (this.rawAbort) {
      this.session.abort = async () => {
        this.cancelActive('Session abort requested by Convergent.');
        const result = await settleWithin(Promise.resolve().then(() => this.rawAbort()), this.controlTimeoutMs);
        if (!result.settled) this.ui?.agentControlTimeout?.(this.agentName, 'abort', this.controlTimeoutMs);
        return result.result;
      };
    }

    if (this.rawDisconnect) {
      this.session.disconnect = async () => {
        this.cancelActive('Session disconnect requested by Convergent.');
        const result = await settleWithin(Promise.resolve().then(() => this.rawDisconnect()), this.controlTimeoutMs);
        if (!result.settled) this.ui?.agentControlTimeout?.(this.agentName, 'disconnect', this.controlTimeoutMs);
        this.dispose();
        return result.result;
      };
    }
  }

  cancelActive(reason) {
    const diagnostic = this.snapshot();
    for (const reject of [...this.activeRejectors]) {
      reject(makeControlError(reason, 'CONVERGENT_CANCELLED', diagnostic));
    }
    this.activeRejectors.clear();
  }

  async steerStalledTool(tool) {
    if (!this.rawSend) return;
    const prompt = [
      `Convergent watchdog: your ${tool.name} tool has produced no progress for ${Math.round((Date.now() - tool.lastProgressAt) / 1000)} seconds.`,
      'Stop waiting for that operation if possible. Do not retry the same command unchanged. Use a bounded/non-blocking alternative or report the obstacle promptly.',
    ].join(' ');
    const result = await settleWithin(
      Promise.resolve().then(() => this.rawSend({ prompt, mode: 'immediate' })),
      Math.min(this.controlTimeoutMs, 2_000),
    );
    if (!result.settled) this.ui?.agentControlTimeout?.(this.agentName, 'immediate steering', Math.min(this.controlTimeoutMs, 2_000));
  }

  async forceAbortAfterStall() {
    if (!this.rawAbort) return;
    const result = await settleWithin(Promise.resolve().then(() => this.rawAbort()), this.controlTimeoutMs);
    if (!result.settled) this.ui?.agentControlTimeout?.(this.agentName, 'abort after stall', this.controlTimeoutMs);
  }

  guardedSendAndWait(options, timeoutMs) {
    const operation = this.rawSendAndWait(options, timeoutMs);
    let timer;
    let active = true;

    const control = new Promise((_, reject) => {
      this.activeRejectors.add(reject);
      timer = setInterval(() => {
        if (!active) return;
        const now = Date.now();
        const tool = this.currentTool;

        if (now - this.lastHeartbeatAt >= this.heartbeatMs) {
          this.lastHeartbeatAt = now;
          this.ui?.agentHeartbeat?.(this.agentName, this.snapshot());
        }

        if (!tool) return;
        const quietMs = now - tool.lastProgressAt;
        if (quietMs < this.toolStallTimeoutMs) return;

        if (!tool.steeringSentAt) {
          tool.steeringSentAt = now;
          this.ui?.agentToolStallWarning?.(this.agentName, tool.name, quietMs, this.toolStallTimeoutMs);
          void this.steerStalledTool(tool);
          return;
        }

        if (now - tool.steeringSentAt < this.stallGraceMs) return;

        const diagnostic = this.snapshot();
        this.stalls.push({
          at: new Date(now).toISOString(),
          tool: tool.name,
          toolCallId: tool.id,
          quietMs,
          elapsedMs: now - tool.startedAt,
        });
        this.ui?.agentToolStalled?.(this.agentName, tool.name, now - tool.startedAt, diagnostic);
        active = false;
        reject(makeControlError(
          `${this.agentName} tool ${tool.name} stalled for ${Math.round(quietMs / 1000)}s without progress.`,
          'CONVERGENT_TOOL_STALL',
          diagnostic,
        ));
        void this.forceAbortAfterStall();
      }, 1_000);
      timer.unref?.();
    });

    return Promise.race([operation, control]).finally(() => {
      active = false;
      if (timer) clearInterval(timer);
      // The reject function becomes unreachable after Promise.race settles; clear all
      // current rejectors when there is no longer an active guarded send.
      this.activeRejectors.clear();
    });
  }

  snapshot() {
    const now = Date.now();
    const tools = [...this.toolStats.entries()]
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.maxMs - a.maxMs);
    return {
      agent: this.agentName,
      elapsedMs: now - this.startedAt,
      lastActivityAgoMs: now - this.lastActivityAt,
      currentTool: this.currentTool ? {
        name: this.currentTool.name,
        toolCallId: this.currentTool.id,
        elapsedMs: now - this.currentTool.startedAt,
        quietMs: now - this.currentTool.lastProgressAt,
        steeringSent: Boolean(this.currentTool.steeringSentAt),
      } : null,
      tools,
      stalls: [...this.stalls],
    };
  }

  dispose() {
    for (const dispose of this.disposers.splice(0)) {
      try { dispose?.(); } catch {}
    }
  }
}

function guardSession(session, agentName, ui, options = {}) {
  return new SessionGuard(session, agentName, ui, options);
}

module.exports = {
  SessionGuard,
  guardSession,
  settleWithin,
  DEFAULT_TOOL_STALL_TIMEOUT_MS,
  DEFAULT_STALL_GRACE_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_CONTROL_TIMEOUT_MS,
};
