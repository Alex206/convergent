'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cargoValidationWithoutLock,
  mutatingValidationCommand,
  reviewerValidationPolicy,
} = require('../src/copilot/read-only-validation');
const { OperatorCredentialGuard } = require('../src/copilot/operator-credential-guard');
const { createRunCommandTool } = require('../src/copilot/run-command-tool');

function defineTool(name, config) {
  return { name, ...config };
}

function runtimeStub() {
  const calls = [];
  return {
    calls,
    async execute(owner, request) {
      calls.push({ owner, request });
      return {
        commandId: 'cmd-test',
        pid: 123,
        state: 'exited',
        exitCode: 0,
        signal: null,
        elapsedMs: 1,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        termination: { proven: true },
      };
    },
  };
}

test('reviewer Cargo validation requires an immutable lockfile mode', () => {
  assert.equal(cargoValidationWithoutLock('cargo test --quiet'), true);
  assert.equal(cargoValidationWithoutLock('cargo check --all-targets'), true);
  assert.equal(cargoValidationWithoutLock('if ($ok) { cargo test --quiet }'), true);
  assert.equal(cargoValidationWithoutLock('cargo clippy --locked --all-targets'), false);
  assert.equal(cargoValidationWithoutLock('if ($ok) { cargo test --frozen --quiet }'), false);

  const denied = reviewerValidationPolicy('Contract & integration reviewer', 'cargo test --quiet');
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /--locked|--frozen/i);
  assert.equal(reviewerValidationPolicy('Worker A', 'cargo test --quiet').allowed, true);
});

test('validation policy recognizes formatter modes that modify source', () => {
  assert.equal(mutatingValidationCommand('cargo fmt'), true);
  assert.equal(mutatingValidationCommand('if ($dirty) { cargo fmt }'), true);
  assert.equal(mutatingValidationCommand('cargo fmt --check'), false);
  assert.equal(mutatingValidationCommand('prettier . --write'), true);
  assert.equal(mutatingValidationCommand('dotnet format'), true);
  assert.equal(mutatingValidationCommand('dotnet format --verify-no-changes'), false);
});

test('managed reviewer command is denied before execution when Cargo could create Cargo.lock', async () => {
  const runtime = runtimeStub();
  let permissions = 0;
  const tool = createRunCommandTool(defineTool, {
    runtime,
    workspace: process.cwd(),
    owner: 'State & resources reviewer',
    permissionHandler: async () => {
      permissions += 1;
      return { kind: 'approve' };
    },
  });

  const result = await tool.handler({ command: 'cargo test --quiet' });
  assert.equal(result.accepted, false);
  assert.match(result.error, /Cargo validation must preserve Git-visible workspace state/i);
  assert.equal(runtime.calls.length, 0);
  assert.equal(permissions, 0);
});

test('managed reviewer command permits Cargo validation with --locked', async () => {
  const runtime = runtimeStub();
  const tool = createRunCommandTool(defineTool, {
    runtime,
    workspace: process.cwd(),
    owner: 'Strong reviewer',
    permissionHandler: async () => ({ kind: 'approve' }),
  });

  const result = await tool.handler({ command: 'cargo test --locked --quiet' });
  assert.equal(result.exitCode, 0);
  assert.equal(runtime.calls.length, 1);
});

test('builtin reviewer shell is guarded by the same immutable-validation policy', () => {
  const guard = new OperatorCredentialGuard({ environment: {} });
  const denied = guard.hook({
    toolName: 'builtin:powershell',
    toolArgs: { command: 'if ($LASTEXITCODE -eq 0) { cargo test --quiet }' },
  }, { agent: 'Strong reviewer' });
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /--locked|--frozen/i);

  const allowed = guard.hook({
    toolName: 'builtin:powershell',
    toolArgs: { command: 'if ($LASTEXITCODE -eq 0) { cargo test --locked --quiet }' },
  }, { agent: 'Strong reviewer' });
  assert.equal(allowed.permissionDecision, 'allow');
});

test('worker shell validation cannot rewrite source with a formatter', () => {
  const guard = new OperatorCredentialGuard({ environment: {} });
  const denied = guard.hook({
    toolName: 'run_command',
    toolArgs: { command: 'cargo fmt' },
  }, { agent: 'Worker A' });
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /must not rewrite source files/i);

  const allowed = guard.hook({
    toolName: 'run_command',
    toolArgs: { command: 'cargo fmt --check' },
  }, { agent: 'Worker A' });
  assert.equal(allowed.permissionDecision, 'allow');
});
