'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CancellationBridge,
  ResponseStreamBridge,
  workflowInProgress,
  rebindGuardStreams,
  sendSteeringInstruction,
} = require('../src/ui/live-chat-control');
const { VscodeWorkflowUi } = require('../src/ui/vscode-ui-0.5');
const { SessionGuard } = require('../src/copilot/session-guard-0.5');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cancellationSource() {
  const listeners = new Set();
  let cancelled = false;
  return {
    token: {
      get isCancellationRequested() { return cancelled; },
      onCancellationRequested(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
    cancel() {
      cancelled = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

function fakeSession({ send, abort, disconnect } = {}) {
  const handlers = new Map();
  const session = {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => handlers.set(name, (handlers.get(name) ?? []).filter((item) => item !== handler));
    },
    emit(name, data) {
      for (const handler of handlers.get(name) ?? []) handler({ data });
    },
    send: send ?? (async () => {}),
    abort: abort ?? (async () => {}),
    disconnect: disconnect ?? (async () => {}),
  };
  return session;
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(10);
  return predicate();
}

test('chat supersession cancellation is not forwarded when the next request adopts the live run', async () => {
  const first = cancellationSource();
  const second = cancellationSource();
  const bridge = new CancellationBridge({ graceMs: 30 });
  let forwarded = 0;
  bridge.token.onCancellationRequested(() => { forwarded += 1; });
  bridge.adopt(first.token);

  first.cancel();
  await delay(10);
  assert.equal(forwarded, 0, 'the old participant cancellation is held during the steering grace window');

  assert.equal(bridge.adopt(second.token), true);
  await delay(40);
  assert.equal(forwarded, 0, 'adopting the follow-up request cancels the old cancellation');

  second.cancel();
  await delay(40);
  assert.equal(forwarded, 1, 'cancellation of the adopted request is forwarded after the grace window');
  bridge.markSettled();
});

test('response stream bridge redirects the original long-running handler to the adopted follow-up response', () => {
  const first = [];
  const second = [];
  const streamBridge = new ResponseStreamBridge({
    markdown: (value) => first.push(`markdown:${value}`),
    progress: (value) => first.push(`progress:${value}`),
  });

  streamBridge.proxy.markdown('before steering');
  assert.deepEqual(first, ['markdown:before steering']);

  streamBridge.adopt({
    markdown: (value) => second.push(`markdown:${value}`),
    progress: (value) => second.push(`progress:${value}`),
  });
  streamBridge.proxy.progress('after steering');
  streamBridge.proxy.markdown('finished');
  assert.deepEqual(first, ['markdown:before steering']);
  assert.deepEqual(second, ['progress:after steering', 'markdown:finished']);
});

test('live workflow evidence and stream rebinding keep follow-up chat on the active run', () => {
  const stream = { id: 'new-stream' };
  const sharedUi = { stream: { id: 'old-stream' } };
  const guards = [{ ui: sharedUi }, { ui: sharedUi }];
  assert.equal(workflowInProgress(guards, null), true);
  assert.equal(workflowInProgress([], { status: 'running' }), true);
  assert.equal(workflowInProgress([], { status: 'complete' }), false);
  assert.equal(rebindGuardStreams(guards, stream), 1);
  assert.equal(sharedUi.stream, stream);
});

test('follow-up steering is injected into the active Copilot turn instead of becoming a new task', async () => {
  const sends = [];
  const guard = {
    agentName: 'Worker A',
    rawSend: async (options) => sends.push(options),
    snapshot: () => ({ currentTool: { name: 'run_command', toolCallId: 'tool-1' } }),
  };
  const result = await sendSteeringInstruction(guard, 'we have enough examples; analyze them now');
  assert.equal(result.sent, true);
  assert.equal(result.agent, 'Worker A');
  assert.equal(result.currentTool.toolCallId, 'tool-1');
  assert.deepEqual(sends, [{
    prompt: 'Operator steering instruction from the user: we have enough examples; analyze them now',
    mode: 'immediate',
  }]);
});

test('explicit long-tool wait suppresses repetitive chat heartbeats and retains a fresh terminate control', async () => {
  const progress = [];
  const buttons = [];
  const logs = [];
  const stream = {
    progress: (value) => progress.push(value),
    markdown() {},
    button: (value) => buttons.push(value),
  };
  const ui = new VscodeWorkflowUi(
    { window: { showWarningMessage: async () => undefined } },
    stream,
    { appendLine: (value) => logs.push(value) },
    {},
  );

  ui.agentHeartbeat('Worker A', {
    currentTool: {
      name: 'run_command',
      detail: 'python collect.py',
      elapsedMs: 1_000_000,
      quietMs: 900_000,
      waitExtendedMs: 600_000,
      decisionPending: false,
    },
  });
  assert.equal(progress.length, 0, 'the selected wait interval should not spam Chat with duplicate heartbeats');
  assert.match(logs.join('\n'), /operator wait remaining/i, 'diagnostics remain live in Output');

  const decisionPromise = ui.agentToolStallDecision('Worker A', {
    currentTool: {
      name: 'run_command',
      detail: 'python collect.py',
      toolCallId: 'tool-42',
      elapsedMs: 120_000,
      quietMs: 120_000,
    },
  });
  const continueButton = buttons.find((button) => button.title === 'Continue 15 min');
  assert.ok(continueButton);
  assert.equal(ui.resolveChatDecision(...continueButton.arguments), true);
  assert.deepEqual(await decisionPromise, { action: 'continue', waitMs: 15 * 60_000 });

  ui.agentToolWaitExtended('Worker A', 'run_command', 15 * 60_000);
  const terminateButton = buttons.find((button) => button.title === 'Terminate command & recover now');
  assert.ok(terminateButton, 'operator keeps a live termination control after choosing Continue');
  assert.deepEqual(terminateButton.arguments, ['Worker A', 'tool-42', '']);
});

test('live terminate control kills the exact managed command and raises a recoverable stall with steering provenance', async () => {
  let session;
  let aborts = 0;
  let abortReason = null;
  session = fakeSession({
    send: async () => {
      session.emit('tool.execution_start', {
        toolCallId: 'tool-1',
        toolName: 'run_command',
        arguments: { command: 'python collect.py' },
      });
    },
    abort: async () => { aborts += 1; },
  });
  const guard = new SessionGuard(session, 'Worker A', {}, {
    heartbeatMs: 60_000,
    toolStallTimeoutMs: 60_000,
    agentInactivityTimeoutMs: 60_000,
    beforeAbort: async ({ reason }) => {
      abortReason = reason;
      return { active: true, proven: true, commandId: 'cmd-1', pid: 1234, method: 'test' };
    },
  });

  const pending = session.sendAndWait({ prompt: 'collect examples' });
  assert.equal(await waitFor(() => guard.activeRejectors.size > 0 && guard.snapshot().currentTool?.toolCallId === 'tool-1'), true);

  const terminated = await guard.terminateCurrentManagedCommand('tool-1', 'enough examples; analyze them now');
  assert.equal(terminated.terminated, true);
  assert.equal(terminated.termination.proven, true);
  assert.equal(abortReason, 'operator-managed-command');
  assert.equal(aborts, 1);
  await assert.rejects(
    pending,
    (error) => {
      assert.equal(error.code, 'CONVERGENT_TOOL_STALL');
      assert.equal(error.convergentDiagnostic.managedCommandTermination.proven, true);
      assert.match(error.convergentDiagnostic.operatorGuidance, /enough examples/i);
      assert.match(error.message, /terminated by the operator/i);
      return true;
    },
  );
});
