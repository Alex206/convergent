'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SessionFactory,
  readonlyHook,
  workerHook,
  readonlyShellMutation,
  shellFileContentMutation,
  safeSessionPart,
  SHELL_BUILTINS,
  COORDINATOR_TOOLS,
  RECOVERY_COORDINATOR_TOOLS,
  WORKER_TOOLS,
  REVIEWER_TOOLS,
} = require('../src/copilot/session-factory');

test('strong reviewer hook blocks write tools', () => {
  assert.equal(readonlyHook({ toolName: 'edit' }).permissionDecision, 'deny');
  assert.equal(readonlyHook({ toolName: 'write_file' }).permissionDecision, 'deny');
  assert.equal(readonlyHook({ toolName: 'apply_patch' }).permissionDecision, 'deny');
});

test('read-only roles allow diagnostic shell commands without separate permission prompts', () => {
  assert.equal(readonlyHook({ toolName: 'powershell', toolArgs: { command: 'git status --short' } }).permissionDecision, 'allow');
  assert.equal(readonlyHook({ toolName: 'bash', toolArgs: { command: 'git diff -- README.md' } }).permissionDecision, 'allow');
  assert.equal(readonlyHook({ toolName: 'grep', toolArgs: { pattern: 'foo' } }).permissionDecision, 'allow');
});

test('read-only roles deny obvious shell mutations before execution', () => {
  assert.equal(readonlyShellMutation({ toolName: 'powershell', toolArgs: { command: 'Set-Content README.md changed' } }), true);
  assert.equal(readonlyHook({ toolName: 'powershell', toolArgs: { command: 'git reset --hard HEAD~1' } }).permissionDecision, 'deny');
  assert.equal(readonlyHook({ toolName: 'bash', toolArgs: { command: 'rm -rf src' } }).permissionDecision, 'deny');
});

test('worker hook blocks shell file-content editing but allows validation and cleanup', () => {
  assert.equal(shellFileContentMutation({ toolName: 'powershell', toolArgs: { command: 'Set-Content README.md changed' } }), true);
  assert.equal(workerHook({ toolName: 'powershell', toolArgs: { command: 'Set-Content README.md changed' } }).permissionDecision, 'deny');
  assert.equal(workerHook({ toolName: 'bash', toolArgs: { command: 'printf hello > README.md' } }).permissionDecision, 'deny');
  assert.equal(workerHook({ toolName: 'bash', toolArgs: { command: 'apply_patch <<PATCH' } }).permissionDecision, 'deny');
  assert.equal(workerHook({ toolName: 'powershell', toolArgs: { command: 'python -B -m unittest -v' } }).permissionDecision, 'allow');
  assert.equal(shellFileContentMutation({ toolName: 'powershell', toolArgs: { command: 'Remove-Item -Recurse __pycache__' } }), false);
});

test('role tool allowlists expose purpose-built tools and keep recovery coordinator read-only', () => {
  assert.equal(SHELL_BUILTINS.length, 1);
  assert.ok(COORDINATOR_TOOLS.includes('builtin:view'));
  assert.ok(COORDINATOR_TOOLS.includes('builtin:ask_user'));
  assert.ok(COORDINATOR_TOOLS.includes('custom:report_plan'));
  assert.ok(!COORDINATOR_TOOLS.includes('builtin:edit'));
  assert.ok(!COORDINATOR_TOOLS.includes('builtin:create'));
  assert.ok(!COORDINATOR_TOOLS.includes('builtin:apply_patch'));

  assert.ok(RECOVERY_COORDINATOR_TOOLS.includes('builtin:view'));
  assert.ok(RECOVERY_COORDINATOR_TOOLS.includes('custom:report_recovery'));
  assert.ok(!RECOVERY_COORDINATOR_TOOLS.includes('builtin:edit'));
  assert.ok(!RECOVERY_COORDINATOR_TOOLS.includes('builtin:ask_user'));

  assert.ok(REVIEWER_TOOLS.includes('custom:report_review'));
  assert.ok(!REVIEWER_TOOLS.includes('builtin:edit'));
  assert.ok(!REVIEWER_TOOLS.includes('builtin:apply_patch'));
  assert.ok(!REVIEWER_TOOLS.includes('builtin:ask_user'));

  assert.ok(WORKER_TOOLS.includes('builtin:apply_patch'));
  assert.ok(WORKER_TOOLS.includes('builtin:edit'));
  assert.ok(WORKER_TOOLS.includes('builtin:create'));
  assert.ok(WORKER_TOOLS.includes('custom:workspace_edit'));
  assert.ok(WORKER_TOOLS.includes('custom:report_pass'));
  assert.ok(!WORKER_TOOLS.includes('builtin:ask_user'));
});

test('session ids sanitize coordinator-provided task ids', () => {
  assert.equal(safeSessionPart('Task 1 / Windows runner'), 'Task-1-Windows-runner');
  assert.equal(safeSessionPart('///'), 'task');
});

test('session factory promotes high-risk Worker A and keeps Worker B capable and diverse', () => {
  const factory = new SessionFactory({
    client: {}, sdk: {}, workspace: '/repo', ui: {}, runId: 'run',
    models: {
      workerASelector: 'adaptive',
      workerBSelector: 'adaptive-diverse',
      available: [
        { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
        { id: 'gpt-5.5', name: 'GPT-5.5' },
      ],
    },
  });

  const a = factory.workerModel('T2', 'A', 'high_risk', 'high');
  const b = factory.workerModel('T2', 'B', 'high_risk', 'high');
  assert.equal(a.id, 'gpt-5.5');
  assert.equal(b.id, 'gpt-5.4-mini');
  assert.notEqual(a.id, b.id);
});

test('guard audits the exact Convergent prompt sent into an agent turn', async () => {
  const handlers = new Map();
  const emittedAudit = [];
  const session = {
    sessionId: 's1',
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {};
    },
    async send() {
      queueMicrotask(() => {
        for (const handler of handlers.get('session.idle') ?? []) handler({ data: {} });
      });
    },
    async abort() {},
    async disconnect() {},
  };
  const ui = {
    auditEvent(event) { emittedAudit.push(event); },
  };
  const factory = new SessionFactory({ client: {}, sdk: {}, workspace: '/repo', ui, runId: 'run', models: {} });
  factory.guard(session, 'Worker A');

  await session.sendAndWait({ prompt: 'exact task/pass prompt', mode: 'normal' });

  const event = emittedAudit.find((item) => item.type === 'prompt_send');
  assert.equal(event.agent, 'Worker A');
  assert.equal(event.sessionId, 's1');
  assert.equal(event.prompt, 'exact task/pass prompt');
});
