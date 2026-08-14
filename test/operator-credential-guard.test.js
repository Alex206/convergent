'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hookToolArguments,
  isSensitiveCredentialName,
  assignedEnvironmentNames,
  OperatorCredentialGuard,
  reconcileCredentialIntegrityReport,
} = require('../src/headless/operator-credential-guard');

function shell(command, toolName = 'builtin:bash') {
  return { toolName, toolArgs: { command } };
}

function cliShell(command, toolName = 'bash') {
  return { toolName, toolArgs: JSON.stringify({ command, description: 'validation', initial_wait: 30 }) };
}

test('parses object and JSON-string Copilot hook argument shapes', () => {
  assert.equal(hookToolArguments(shell('echo ok')).command, 'echo ok');
  assert.equal(hookToolArguments(cliShell('echo cli')).command, 'echo cli');
  assert.equal(hookToolArguments({ toolName: 'bash', toolArgs: 'not-json' }).input, 'not-json');
});

test('credential assignment detection covers bash, Copilot CLI JSON-string args, and PowerShell without treating ordinary environment flags as credentials', () => {
  assert.deepEqual(
    assignedEnvironmentNames(shell('TASKFLOW_RELEASE_TOKEN=test-token python tools/validate_release_signature.py')),
    ['TASKFLOW_RELEASE_TOKEN'],
  );
  assert.deepEqual(
    assignedEnvironmentNames(cliShell('TASKFLOW_RELEASE_TOKEN=benchmark-only-secret python tools/validate_release_signature.py')),
    ['TASKFLOW_RELEASE_TOKEN'],
  );
  assert.deepEqual(
    assignedEnvironmentNames(shell("$env:TASKFLOW_RELEASE_TOKEN='test-token'; python tools/validate_release_signature.py", 'builtin:powershell')),
    ['TASKFLOW_RELEASE_TOKEN'],
  );
  assert.equal(isSensitiveCredentialName('TASKFLOW_RELEASE_TOKEN'), true);
  assert.equal(isSensitiveCredentialName('CLIENT_SECRET'), true);
  assert.equal(isSensitiveCredentialName('AWS_SECRET_ACCESS_KEY'), true);
  assert.equal(isSensitiveCredentialName('NODE_ENV'), false);
});

test('guard denies invented operator credentials for object and real CLI JSON-string hook shapes but allows ordinary environment assignments', () => {
  for (const input of [
    shell('TASKFLOW_RELEASE_TOKEN=test-token python tools/validate_release_signature.py'),
    cliShell('TASKFLOW_RELEASE_TOKEN=benchmark-only-secret python tools/validate_release_signature.py'),
  ]) {
    const guard = new OperatorCredentialGuard({ environment: {} });
    const denied = guard.hook(input, { agent: 'A' });
    assert.equal(denied.permissionDecision, 'deny');
    assert.match(denied.permissionDecisionReason, /report BLOCKED/i);
    assert.match(denied.permissionDecisionReason, /TASKFLOW_RELEASE_TOKEN/);
    assert.deepEqual(guard.consumeViolations('A'), [{ names: ['TASKFLOW_RELEASE_TOKEN'] }]);
  }

  const guard = new OperatorCredentialGuard({ environment: {} });
  const allowed = guard.hook(cliShell('NODE_ENV=test node --test'), { agent: 'A' });
  assert.equal(allowed.permissionDecision, 'allow');
  assert.deepEqual(guard.consumeViolations('A'), []);
});

test('guard supports VS Code-compatible snake_case hook input as a conservative fallback', () => {
  const guard = new OperatorCredentialGuard({ environment: {} });
  const denied = guard.hook({
    tool_name: 'Bash',
    tool_input: { command: 'CLIENT_SECRET=made-up python validator.py' },
  }, { agent: 'A' });
  assert.equal(denied.permissionDecision, 'deny');
  assert.deepEqual(guard.consumeViolations('A'), [{ names: ['CLIENT_SECRET'] }]);
});

test('guard allows credentials inherited from the host environment', () => {
  const guard = new OperatorCredentialGuard({
    environment: { TASKFLOW_RELEASE_TOKEN: 'real-operator-value' },
  });
  const result = guard.hook(
    cliShell('TASKFLOW_RELEASE_TOKEN="$TASKFLOW_RELEASE_TOKEN" python tools/validate_release_signature.py'),
    { agent: 'A' },
  );
  assert.equal(result.permissionDecision, 'allow');
  assert.deepEqual(guard.consumeViolations('A'), []);
});

test('guard unlocks only credential names carried through explicit operator recovery context', () => {
  const guard = new OperatorCredentialGuard({ environment: {} });
  assert.deepEqual(
    guard.authorizeFromOperatorGuidance('Use TASKFLOW_RELEASE_TOKEN=benchmark-only-secret for validation.'),
    [],
  );
  assert.equal(
    guard.hook(cliShell('TASKFLOW_RELEASE_TOKEN=benchmark-only-secret python validator.py'), { agent: 'A' }).permissionDecision,
    'deny',
  );
  guard.consumeViolations('A');

  assert.deepEqual(
    guard.authorizeFromOperatorGuidance('Operator context: Use TASKFLOW_RELEASE_TOKEN=benchmark-only-secret only for validation.'),
    ['TASKFLOW_RELEASE_TOKEN'],
  );
  assert.equal(
    guard.hook(cliShell('TASKFLOW_RELEASE_TOKEN=benchmark-only-secret python validator.py'), { agent: 'A' }).permissionDecision,
    'allow',
  );
});

test('credential-integrity violation deterministically reconciles an optimistic report to BLOCKED without retaining secret values', () => {
  const original = {
    verdict: 'clean',
    summary: 'Implementation and validation passed.',
    checks: ['unit tests passed'],
    findings: [],
  };
  const reconciled = reconcileCredentialIntegrityReport(
    original,
    [{ names: ['TASKFLOW_RELEASE_TOKEN'] }],
    'Worker A',
  );

  assert.equal(reconciled.report.verdict, 'blocked');
  assert.deepEqual(reconciled.report.findings, []);
  assert.match(reconciled.report.summary, /Operator context is required/);
  assert.match(reconciled.report.summary, /TASKFLOW_RELEASE_TOKEN/);
  assert.doesNotMatch(JSON.stringify(reconciled.report), /benchmark-only-secret|test-token/);
  assert.match(reconciled.correction, /reconciled to BLOCKED/);
});

test('credential-integrity violation preserves an existing BLOCKED report and adds deterministic evidence', () => {
  const reconciled = reconcileCredentialIntegrityReport(
    {
      verdict: 'blocked',
      summary: 'Validator requires TASKFLOW_RELEASE_TOKEN.',
      checks: ['validator exited 2'],
      findings: [],
    },
    [{ names: ['TASKFLOW_RELEASE_TOKEN'] }],
    'Worker A',
  );
  assert.equal(reconciled.report.verdict, 'blocked');
  assert.equal(reconciled.report.checks.length, 2);
  assert.match(reconciled.report.checks[1], /denied synthetic assignment/);
});
