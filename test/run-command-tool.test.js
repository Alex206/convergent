'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRunCommandTool, normalizeCwd, clampTimeoutSeconds } = require('../src/copilot/run-command-tool');

test('run_command normalizes cwd and timeout and forwards managed lifecycle progress', async () => {
  let definition;
  const defineTool = (name, config) => {
    definition = { name, ...config };
    return definition;
  };
  const progress = [];
  const audits = [];
  const runtime = {
    async execute(owner, options) {
      assert.equal(owner, 'Worker A');
      assert.equal(options.command, 'node --test');
      assert.equal(options.cwd, 'test');
      assert.equal(options.timeoutMs, 12_000);
      options.onStart({ commandId: 'cmd-1', pid: 123, cwd: path.join('/workspace', 'test'), startedAt: Date.now() });
      options.onOutput({ commandId: 'cmd-1', pid: 123, stream: 'stdout', chunk: 'ok', bytes: 2, elapsedMs: 5 });
      return {
        commandId: 'cmd-1', pid: 123, state: 'completed', exitCode: 0, signal: null,
        elapsedMs: 8, stdout: 'ok', stderr: '', stdoutTruncated: false, stderrTruncated: false, termination: null,
      };
    },
  };
  const guard = { managedCommandProgress: (event) => progress.push(event) };
  const ui = { auditEvent: (event) => { audits.push(event); } };
  createRunCommandTool(defineTool, { runtime, workspace: '/workspace', owner: 'Worker A', ui, permissionHandler: async (request) => { assert.equal(request.kind, 'shell'); assert.equal(request.fullCommandText, 'node --test'); return { kind: 'approve-once' }; }, getGuard: () => guard });

  assert.equal(definition.name, 'run_command');
  assert.equal(definition.defer, 'never');
  const result = await definition.handler({ command: ' node --test ', cwd: 'test', timeoutSeconds: 12 });

  assert.equal(result.state, 'completed');
  assert.deepEqual(progress.map((item) => item.phase), ['started', 'output']);
  assert.deepEqual(audits.map((event) => event.type), ['managed_command_start', 'managed_command_progress', 'managed_command_complete']);
  assert.equal(audits[1].bytes, 2);
  assert.equal(Object.hasOwn(audits[1], 'chunk'), false, 'progress audit must not duplicate command output content');
});


test('run_command routes command text through Convergent shell permission policy before spawn', async () => {
  let definition;
  let runtimeCalls = 0;
  let permissionRequest;
  const audits = [];
  createRunCommandTool((name, config) => { definition = { name, ...config }; return definition; }, {
    runtime: { execute: async () => { runtimeCalls += 1; } },
    workspace: '/workspace',
    owner: 'Worker A',
    ui: { auditEvent: (event) => audits.push(event) },
    permissionHandler: async (request) => {
      permissionRequest = request;
      return { kind: 'deny' };
    },
  });

  const result = await definition.handler({ command: 'git push origin main', timeoutSeconds: 30 });

  assert.equal(result.accepted, false);
  assert.match(result.error, /permission denied/i);
  assert.equal(runtimeCalls, 0);
  assert.equal(permissionRequest.kind, 'shell');
  assert.equal(permissionRequest.fullCommandText, 'git push origin main');
  assert.equal(permissionRequest.toolName, 'run_command');
  assert.deepEqual(audits.map((event) => event.type), ['managed_command_permission_denied']);
  assert.doesNotMatch(JSON.stringify(audits), /git push origin main/, 'permission-denial audit must not duplicate command text');
});

test('run_command fails closed when no permission handler is available', async () => {
  let definition;
  let runtimeCalls = 0;
  createRunCommandTool((name, config) => { definition = { name, ...config }; return definition; }, {
    runtime: { execute: async () => { runtimeCalls += 1; } },
    workspace: '/workspace',
    owner: 'Worker A',
  });

  const result = await definition.handler({ command: 'node --test' });
  assert.equal(result.accepted, false);
  assert.match(result.error, /permission handler is unavailable/i);
  assert.equal(runtimeCalls, 0);
});

test('run_command rejects workspace escape before invoking runtime', async () => {
  let definition;
  let called = false;
  createRunCommandTool((name, config) => { definition = { name, ...config }; return definition; }, {
    runtime: { execute: async () => { called = true; } },
    workspace: '/workspace',
    owner: 'Strong reviewer',
  });

  const result = await definition.handler({ command: 'echo bad', cwd: '../outside' });
  assert.equal(result.accepted, false);
  assert.match(result.error, /cwd must stay inside/);
  assert.equal(called, false);
});

test('run_command timeout normalization is bounded', () => {
  assert.equal(clampTimeoutSeconds(undefined), 300);
  assert.equal(clampTimeoutSeconds(0), 1);
  assert.equal(clampTimeoutSeconds(999999), 3600);
});

test('normalizeCwd accepts workspace-relative paths and rejects escapes', () => {
  assert.equal(normalizeCwd('/workspace', undefined), '.');
  assert.equal(normalizeCwd('/workspace', 'sub/dir'), path.join('sub', 'dir'));
  assert.throws(() => normalizeCwd('/workspace', '../escape'), /cwd must stay inside/);
});
