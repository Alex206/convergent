'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSensitiveCredentialName,
  assignedEnvironmentNames,
  OperatorCredentialGuard,
  reconcileCredentialIntegrityReport,
} = require('../src/headless/operator-credential-guard');

function shell(command, toolName = 'builtin:bash') {
  return { toolName, toolArgs: { command } };
}

test('credential assignment detection covers bash and PowerShell without treating ordinary environment flags as credentials', () => {
  assert.deepEqual(
    assignedEnvironmentNames(shell('TASKFLOW_RELEASE_TOKEN=test-token python tools/validate_release_signature.py')),
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

test('guard denies invented operator credentials but allows ordinary environment assignments', () => {
  const guard = new OperatorCredentialGuard({ environment: {} });
  const denied = guard.hook(
    shell('TASKFLOW_RELEASE_TOKEN=test-token python tools/validate_release_signature.py'),
    { agent: 'A' },
  );
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /report BLOCKED/i);
  assert.match(denied.permissionDecisionReason, /TASKFLOW_RELEASE_TOKEN/);

  const allowed = guard.hook(shell('NODE_ENV=test node --test'), { agent: 'A' });
  assert.equal(allowed.permissionDecision, 'allow');

  const violations = guard.consumeViolations('A');
  assert.deepEqual(violations, [{ names: ['TASKFLOW_RELEASE_TOKEN'] }]);
  assert.deepEqual(guard.consumeViolations('A'), []);
});

test('guard allows credentials inherited from the host environment', () => {
  const guard = new OperatorCredentialGuard({
    environment: { TASKFLOW_RELEASE_TOKEN: 'real-operator-value' },
  });
  const result = guard.hook(
    shell('TASKFLOW_RELEASE_TOKEN="$TASKFLOW_RELEASE_TOKEN" python tools/validate_release_signature.py'),
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
    guard.hook(shell('TASKFLOW_RELEASE_TOKEN=benchmark-only-secret python validator.py'), { agent: 'A' }).permissionDecision,
    'deny',
  );
  guard.consumeViolations('A');

  assert.deepEqual(
    guard.authorizeFromOperatorGuidance('Operator context: Use TASKFLOW_RELEASE_TOKEN=benchmark-only-secret only for validation.'),
    ['TASKFLOW_RELEASE_TOKEN'],
  );
  assert.equal(
    guard.hook(shell('TASKFLOW_RELEASE_TOKEN=benchmark-only-secret python validator.py'), { agent: 'A' }).permissionDecision,
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
