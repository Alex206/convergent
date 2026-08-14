'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hookToolArguments,
  isSensitiveCredentialName,
  assignedEnvironmentNames,
  OperatorCredentialGuard,
  reconcileCredentialIntegrityReport,
} = require('../src/copilot/operator-credential-guard');

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

test('detects common bash, cmd, and PowerShell credential mutations', () => {
  assert.deepEqual(assignedEnvironmentNames(shell('TASKFLOW_RELEASE_TOKEN=test-token python validator.py')), ['TASKFLOW_RELEASE_TOKEN']);
  assert.deepEqual(assignedEnvironmentNames(cliShell('TASKFLOW_RELEASE_TOKEN=secret python validator.py')), ['TASKFLOW_RELEASE_TOKEN']);
  assert.deepEqual(assignedEnvironmentNames(shell('unset TASKFLOW_RELEASE_TOKEN && python validator.py')), ['TASKFLOW_RELEASE_TOKEN']);
  assert.deepEqual(assignedEnvironmentNames(shell('set "TASKFLOW_RELEASE_TOKEN=test-token" && python validator.py', 'builtin:cmd')), ['TASKFLOW_RELEASE_TOKEN']);
  assert.deepEqual(assignedEnvironmentNames(shell('setx "TASKFLOW_RELEASE_TOKEN" "test-token"', 'builtin:cmd')), ['TASKFLOW_RELEASE_TOKEN']);
  assert.deepEqual(assignedEnvironmentNames(shell("$env:TASKFLOW_RELEASE_TOKEN='test-token'; python validator.py", 'builtin:powershell')), ['TASKFLOW_RELEASE_TOKEN']);
  assert.deepEqual(assignedEnvironmentNames(shell("Set-Item -Path 'Env:TASKFLOW_RELEASE_TOKEN' -Value 'test-token'", 'builtin:powershell')), ['TASKFLOW_RELEASE_TOKEN']);
  assert.deepEqual(assignedEnvironmentNames(shell("Remove-Item 'Env:TASKFLOW_RELEASE_TOKEN'", 'builtin:powershell')), ['TASKFLOW_RELEASE_TOKEN']);
  assert.equal(isSensitiveCredentialName('CLIENT_SECRET'), true);
  assert.equal(isSensitiveCredentialName('AWS_SECRET_ACCESS_KEY'), true);
  assert.equal(isSensitiveCredentialName('GITHUB_PAT'), true);
  assert.equal(isSensitiveCredentialName('NODE_ENV'), false);
});

test('denies invented credentials while allowing ordinary environment assignments', () => {
  const guard = new OperatorCredentialGuard({ environment: {} });
  const denied = guard.hook(cliShell('TASKFLOW_RELEASE_TOKEN=made-up python validator.py'), { agent: 'Worker A' });
  assert.equal(denied.permissionDecision, 'deny');
  assert.deepEqual(guard.consumeViolations('Worker A'), [{ names: ['TASKFLOW_RELEASE_TOKEN'] }]);
  assert.equal(guard.hook(cliShell('NODE_ENV=test node --test'), { agent: 'Worker A' }).permissionDecision, 'allow');
});

test('allows inherited credential use without reassignment', () => {
  const guard = new OperatorCredentialGuard({ environment: { TASKFLOW_RELEASE_TOKEN: 'real-value' } });
  assert.equal(
    guard.hook(cliShell('python tools/validator.py "$TASKFLOW_RELEASE_TOKEN"'), { agent: 'Worker A' }).permissionDecision,
    'allow',
  );
  assert.equal(
    guard.hook(shell('python validator.py $env:TASKFLOW_RELEASE_TOKEN', 'builtin:powershell'), { agent: 'Worker A' }).permissionDecision,
    'allow',
  );
});

test('denies overwriting an inherited credential until operator recovery explicitly authorizes the name', () => {
  const guard = new OperatorCredentialGuard({ environment: { TASKFLOW_RELEASE_TOKEN: 'real-value' } });
  const denied = guard.hook(cliShell('TASKFLOW_RELEASE_TOKEN=made-up python validator.py'), { agent: 'Worker A' });
  assert.equal(denied.permissionDecision, 'deny');
  assert.deepEqual(guard.consumeViolations('Worker A'), [{ names: ['TASKFLOW_RELEASE_TOKEN'] }]);

  assert.deepEqual(
    guard.authorizeFromOperatorGuidance('Operator context: set TASKFLOW_RELEASE_TOKEN to the supplied benchmark value for this retry.'),
    ['TASKFLOW_RELEASE_TOKEN'],
  );
  assert.equal(
    guard.hook(cliShell('TASKFLOW_RELEASE_TOKEN=operator-supplied python validator.py'), { agent: 'Worker A' }).permissionDecision,
    'allow',
  );
});

test('unlocks only credential names carried through explicit operator recovery context', () => {
  const guard = new OperatorCredentialGuard({ environment: {} });
  assert.deepEqual(guard.authorizeFromOperatorGuidance('Use TASKFLOW_RELEASE_TOKEN for validation.'), []);
  assert.deepEqual(guard.authorizeFromOperatorGuidance('Operator context: authorize TASKFLOW_RELEASE_TOKEN for the retry.'), ['TASKFLOW_RELEASE_TOKEN']);
  assert.equal(guard.hook(cliShell('TASKFLOW_RELEASE_TOKEN=value python validator.py'), { agent: 'Worker A' }).permissionDecision, 'allow');
});

test('credential violation reconciles optimistic report to BLOCKED without retaining the value', () => {
  const reconciled = reconcileCredentialIntegrityReport({
    verdict: 'clean',
    summary: 'Implementation and validation passed.',
    checks: ['unit tests passed'],
    findings: [],
  }, [{ names: ['TASKFLOW_RELEASE_TOKEN'] }], 'Worker A');
  assert.equal(reconciled.report.verdict, 'blocked');
  assert.match(reconciled.report.summary, /Operator context is required/);
  assert.match(reconciled.report.summary, /TASKFLOW_RELEASE_TOKEN/);
  assert.doesNotMatch(JSON.stringify(reconciled.report), /made-up|test-token|real-value|operator-supplied/);
});
