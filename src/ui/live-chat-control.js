'use strict';

const DEFAULT_CHAT_SUPERSESSION_GRACE_MS = 2_000;

function disposable(fn = null) {
  let active = true;
  return {
    dispose() {
      if (!active) return;
      active = false;
      try { fn?.(); } catch {}
    },
  };
}

class CancellationBridge {
  constructor({
    graceMs = DEFAULT_CHAT_SUPERSESSION_GRACE_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.graceMs = Math.max(0, Number(graceMs) || 0);
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.listeners = new Set();
    this.sourceSubscription = null;
    this.pendingTimer = null;
    this.cancelled = false;
    this.settled = false;
    this.completion = null;

    const bridge = this;
    this.token = {
      get isCancellationRequested() {
        return bridge.cancelled;
      },
      onCancellationRequested(listener) {
        if (typeof listener !== 'function') return disposable();
        if (bridge.cancelled) {
          queueMicrotask(() => listener());
          return disposable();
        }
        bridge.listeners.add(listener);
        return disposable(() => bridge.listeners.delete(listener));
      },
    };
  }

  clearPendingCancellation() {
    if (this.pendingTimer === null) return;
    this.clearTimer(this.pendingTimer);
    this.pendingTimer = null;
  }

  scheduleCancellation() {
    if (this.cancelled || this.settled || this.pendingTimer !== null) return;
    this.pendingTimer = this.setTimer(() => {
      this.pendingTimer = null;
      this.forwardNow();
    }, this.graceMs);
    this.pendingTimer?.unref?.();
  }

  attachSource(token) {
    if (this.cancelled || this.settled) return false;
    this.clearPendingCancellation();
    this.sourceSubscription?.dispose?.();
    this.sourceSubscription = null;
    if (!token) return true;
    if (token.isCancellationRequested) {
      this.scheduleCancellation();
      return true;
    }
    if (typeof token.onCancellationRequested === 'function') {
      this.sourceSubscription = token.onCancellationRequested(() => this.scheduleCancellation());
    }
    return true;
  }

  adopt(token) {
    return this.attachSource(token);
  }

  forwardNow() {
    if (this.cancelled || this.settled) return false;
    this.clearPendingCancellation();
    this.cancelled = true;
    for (const listener of [...this.listeners]) {
      try { listener(); } catch {}
    }
    return true;
  }

  setCompletion(promise) {
    this.completion = Promise.resolve(promise);
    return this.completion;
  }

  markSettled() {
    if (this.settled) return;
    this.settled = true;
    this.clearPendingCancellation();
    this.sourceSubscription?.dispose?.();
    this.sourceSubscription = null;
    this.listeners.clear();
  }

  dispose() {
    this.markSettled();
  }
}

function workflowInProgress(guards = [], resumeState = null) {
  if (Array.isArray(guards) && guards.length) return true;
  const status = String(resumeState?.status ?? '').toLowerCase();
  return status === 'running' || status === 'ready';
}

function rebindGuardStreams(guards = [], stream) {
  if (!stream) return 0;
  const rebound = new Set();
  for (const guard of Array.isArray(guards) ? guards : []) {
    const ui = guard?.ui;
    if (!ui || rebound.has(ui)) continue;
    ui.stream = stream;
    rebound.add(ui);
  }
  return rebound.size;
}

async function sendSteeringInstruction(guard, instruction) {
  const text = String(instruction ?? '').trim();
  if (!guard || !text) return { sent: false, reason: 'missing-steering-target' };
  if (typeof guard.rawSend !== 'function') return { sent: false, reason: 'immediate-steering-unavailable' };
  await guard.rawSend({
    prompt: `Operator steering instruction from the user: ${text}`,
    mode: 'immediate',
  });
  guard.__convergentLastOperatorSteering = text;
  return {
    sent: true,
    agent: guard.agentName,
    instruction: text,
    currentTool: guard.snapshot?.().currentTool ?? null,
  };
}

module.exports = {
  DEFAULT_CHAT_SUPERSESSION_GRACE_MS,
  CancellationBridge,
  workflowInProgress,
  rebindGuardStreams,
  sendSteeringInstruction,
};
