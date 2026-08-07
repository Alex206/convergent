'use strict';

const DEFAULT_TOOL_STALL_TIMEOUT_MS = 120_000;
const DEFAULT_AGENT_INACTIVITY_TIMEOUT_MS = 180_000;
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
    this.agentInactivityTimeoutMs = Math.max(1_000, Number(options.agentInactivityTimeoutMs) || DEFAULT_AGENT_INACTIVITY_TIMEOUT_MS);
    this.stallGraceMs = Math.max(1_000, Number(options.stallGraceMs) || DEFAULT_STALL_GRACE_MS);
    this.heartbeatMs = Math.max(1_000, Number(options.heartbeatMs) || DEFAULT_HEARTBEAT_MS);
    this.controlTimeoutMs = Math.max(250, Number(options.controlTimeoutMs) || DEFAULT_CONTROL_TIMEOUT_MS);

    this.currentTool = null;
    this.toolStats = new Map();
    this.stalls = [];
    this.startedAt = Date.now();
    this.lastActivityAt = this.startedAt;
    this.lastHeartbeatAt = 0;
    this.inactivitySteeringSentAt = 0;
    this.activeRejectors = new Set();
    this.disposers = [];

    this.rawSend = typeof session.send === 'function' ? session.send.bind(session) : null;
    this.rawAbort = typeof session.abort === 'function' ? session.abort.bind(session) : null;
    this.rawDisconnect = typeof session.disconnect === 'function' ? session.disconnect.bind(session) : null;

    this.attachEvents();
    this.wrapControlMethods();
    session.__convergentGuard = this;
  }

  touch() {
    this.lastActivityAt = Date.now();
    this.inactivitySteeringSentAt = 0;
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

  wrapControlMethods() {
    // Copilot SDK 1.0.8 sendAndWait() always installs a wall-clock timer:
    // omitting timeout uses 60s, and supplying a timeout still limits the total
    // turn duration rather than inactivity. Agentic turns can legitimately run
    // much longer while continuously making progress, so Convergent implements
    // its own send + session.idle wait and lets the event-driven watchdog own
    // liveness policy.
    this.session.sendAndWait = (options, _sdkWallClockTimeoutMs) => this.guardedSendAndWait(options);

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

  createIdleWait(options) {
    if (!this.rawSend) {
      throw new Error(`${this.agentName} session does not expose send(); cannot run an unbounded agentic turn.`);
    }

    let settled = false;
    let lastAssistantMessage;
    let resolveOperation;
    let rejectOperation;
    const localDisposers = [];

    const cleanup = () => {
      for (const dispose of localDisposers.splice(0)) {
        try { dispose?.(); } catch {}
      }
    };

    const promise = new Promise((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });

    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveOperation(value);
    };

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectOperation(error);
    };

    // Register before send() to preserve the race-safety of SDK sendAndWait().
    localDisposers.push(
      this.session.on('assistant.message', (event) => {
        lastAssistantMessage = event;
      }),
      this.session.on('session.idle', () => resolveOnce(lastAssistantMessage)),
      this.session.on('session.error', (event) => {
        const error = new Error(event?.data?.message ?? `${this.agentName} session error.`);
        if (event?.data?.stack) error.stack = event.data.stack;
        rejectOnce(error);
      }),
    );

    Promise.resolve()
      .then(() => this.rawSend(options))
      .catch(rejectOnce);

    return {
      promise,
      cancel: () => resolveOnce(undefined),
    };
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

  async steerInactiveAgent(quietMs) {
    if (!this.rawSend) return;
    const prompt = [
      `Convergent watchdog: no agent or tool activity has been observed for ${Math.round(quietMs / 1000)} seconds.`,
      'If you are still working, respond or continue with a bounded next action now. If blocked, report the obstacle promptly instead of waiting silently.',
    ].join(' ');
    const result = await settleWithin(
      Promise.resolve().then(() => this.rawSend({ prompt, mode: 'immediate' })),
      Math.min(this.controlTimeoutMs, 2_000),
    );
    if (!result.settled) this.ui?.agentControlTimeout?.(this.agentName, 'inactivity steering', Math.min(this.controlTimeoutMs, 2_000));
  }

  async forceAbortAfterStall() {
    if (!this.rawAbort) return;
    const result = await settleWithin(Promise.resolve().then(() => this.rawAbort()), this.controlTimeoutMs);
    if (!result.settled) this.ui?.agentControlTimeout?.(this.agentName, 'abort after stall', this.controlTimeoutMs);
  }

  guardedSendAndWait(options) {
    this.touch();
    const idleWait = this.createIdleWait(options);
    const operation = idleWait.promise;
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

        if (tool) {
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
            kind: 'tool',
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
          return;
        }

        const inactiveMs = now - this.lastActivityAt;
        if (inactiveMs < this.agentInactivityTimeoutMs) return;

        if (!this.inactivitySteeringSentAt) {
          this.inactivitySteeringSentAt = now;
          this.ui?.agentInactivityWarning?.(this.agentName, inactiveMs, this.agentInactivityTimeoutMs);
          void this.steerInactiveAgent(inactiveMs);
          return;
        }

        if (now - this.inactivitySteeringSentAt < this.stallGraceMs) return;

        const diagnostic = this.snapshot();
        this.stalls.push({
          at: new Date(now).toISOString(),
          kind: 'agent_inactivity',
          tool: null,
          toolCallId: null,
          quietMs: inactiveMs,
          elapsedMs: inactiveMs,
        });
        this.ui?.agentInactivityStalled?.(this.agentName, inactiveMs, diagnostic);
        active = false;
        reject(makeControlError(
          `${this.agentName} produced no agent/tool activity for ${Math.round(inactiveMs / 1000)}s.`,
          'CONVERGENT_AGENT_INACTIVITY',
          diagnostic,
        ));
        void this.forceAbortAfterStall();
      }, 1_000);
      timer.unref?.();
    });

    return Promise.race([operation, control]).finally(() => {
      active = false;
      idleWait.cancel();
      if (timer) clearInterval(timer);
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
      agentInactivityTimeoutMs: this.agentInactivityTimeoutMs,
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
  DEFAULT_AGENT_INACTIVITY_TIMEOUT_MS,
  DEFAULT_STALL_GRACE_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_CONTROL_TIMEOUT_MS,
};
