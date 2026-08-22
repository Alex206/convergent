'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { normalizeTaskRoute } = require('../src/orchestrator/routing');
const { SessionGuard, isInteractiveUserTool } = require('../src/copilot/session-guard');
const { runCommandShellGuidance } = require('../src/copilot/run-command-tool');
const {
  captureWorkspaceChangeState,
  buildTaskChangeManifest,
  formatTaskChangeManifest,
} = require('../src/orchestrator/task-change-manifest');

const execFileAsync = promisify(execFile);

function fakeSession({ send, abort } = {}) {
  const handlers = new Map();
  return {
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
    disconnect: async () => {},
  };
}

function fakeUi(overrides = {}) {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return target[property];
      return () => {};
    },
  });
}

async function git(cwd, ...args) {
  return execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

test('routingReason cannot self-escalate a task through negated high-risk vocabulary', () => {
  const routing = normalizeTaskRoute({
    route: 'standard',
    risk: 'medium',
    architectureSignificance: 'low',
    title: 'Harden repository migration lifecycle',
    description: 'Improve completion, source locking, destination validation, and LFS verification inside the existing migration CLI boundary.',
    acceptanceCriteria: ['Migration outcomes and LFS verification are persisted correctly.'],
    routingReason: 'This is consequential but does not introduce a new external subsystem or an irreversible data migration.',
  });
  assert.equal(routing.route, 'standard');
  assert.equal(routing.risk, 'medium');
  assert.equal(routing.peerConvergence, false);
  assert.doesNotMatch(routing.reason, /concrete task semantics require high-risk treatment/i);
});

test('routingReason is explanatory, while objective security semantics still force high-risk', () => {
  const ordinary = normalizeTaskRoute({
    route: 'standard',
    risk: 'medium',
    title: 'Refactor parser',
    description: 'Simplify parser control flow and tests.',
    acceptanceCriteria: ['Tests pass'],
    routingReason: 'This is not an authentication or credential boundary.',
  });
  assert.equal(ordinary.route, 'standard');
  assert.equal(ordinary.risk, 'medium');

  const security = normalizeTaskRoute({
    route: 'standard',
    risk: 'medium',
    title: 'Change authentication token handling',
    description: 'Modify credential validation.',
    acceptanceCriteria: ['Authentication works'],
    routingReason: 'Existing subsystem boundary.',
  });
  assert.equal(security.route, 'high_risk');
  assert.equal(security.risk, 'high');
});

test('ask_user is classified as an interactive operator wait', () => {
  assert.equal(isInteractiveUserTool('ask_user'), true);
  assert.equal(isInteractiveUserTool('builtin:ask_user'), true);
  assert.equal(isInteractiveUserTool('powershell'), false);
});

test('ask_user wait does not trigger tool-stall or inactivity decisions', async () => {
  let session;
  let toolStallDecisions = 0;
  let inactivityDecisions = 0;
  let aborts = 0;
  session = fakeSession({
    send: async () => {
      session.emit('tool.execution_start', {
        toolCallId: 'ask-1',
        toolName: 'ask_user',
        arguments: { question: 'Choose one' },
      });
    },
    abort: async () => { aborts += 1; },
  });
  const guard = new SessionGuard(session, 'Coordinator', fakeUi({
    async agentToolStallDecision() {
      toolStallDecisions += 1;
      return { action: 'abort' };
    },
    async agentInactivityDecision() {
      inactivityDecisions += 1;
      return { action: 'abort' };
    },
  }), {
    toolStallTimeoutMs: 1_000,
    agentInactivityTimeoutMs: 1_000,
    heartbeatMs: 1_000,
  });

  const pending = session.sendAndWait({ prompt: 'ask operator' });
  await new Promise((resolve) => setTimeout(resolve, 1_150));
  assert.equal(guard.snapshot().currentTool.interactiveWait, true);
  assert.equal(toolStallDecisions, 0);
  assert.equal(inactivityDecisions, 0);
  assert.equal(aborts, 0);

  session.emit('tool.execution_complete', { toolCallId: 'ask-1', success: true });
  session.emit('assistant.message', { content: 'operator answered' });
  session.emit('session.idle', {});
  await pending;
});

test('run_command advertises the actual shell contract explicitly', () => {
  const windows = runCommandShellGuidance('win32');
  assert.match(windows, /Windows PowerShell/i);
  assert.match(windows, /Do not use && or \|\|/);
  assert.match(windows, /LASTEXITCODE/);
  assert.match(runCommandShellGuidance('linux'), /POSIX sh/i);
});

test('task change manifest supplies bounded diff evidence for reviewer starting paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-review-packet-'));
  try {
    await git(root, 'init');
    await git(root, 'config', 'user.email', 'test@example.invalid');
    await git(root, 'config', 'user.name', 'Convergent Test');
    await fs.writeFile(path.join(root, 'app.js'), 'module.exports = 1;\n', 'utf8');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'initial');

    const baseline = await captureWorkspaceChangeState(root);
    await fs.writeFile(path.join(root, 'app.js'), 'module.exports = 2;\n', 'utf8');
    await fs.writeFile(path.join(root, 'new.js'), 'export const value = 3;\n', 'utf8');
    const current = await captureWorkspaceChangeState(root, baseline.head);
    const manifest = buildTaskChangeManifest(baseline, current);
    const formatted = formatTaskChangeManifest(manifest);

    assert.match(formatted, /Bounded current diff evidence/i);
    assert.match(formatted, /module\.exports = 2/);
    assert.match(formatted, /export const value = 3/);
    assert.match(formatted, /Use this packet before reopening whole files/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
