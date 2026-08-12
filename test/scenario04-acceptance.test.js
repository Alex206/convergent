'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  evaluateScenario04Recovery,
  runScenario04Acceptance,
} = require('../src/headless/scenario04-acceptance');

function makeWorkspace({ conforming = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convergent-s04-'));
  fs.mkdirSync(path.join(root, 'taskflow'));
  fs.mkdirSync(path.join(root, 'tools'));
  fs.writeFileSync(path.join(root, 'tools', 'release_payload.txt'), 'release payload\n');
  fs.writeFileSync(path.join(root, 'tools', 'validate_release_signature.py'), `
import hashlib, hmac, os
from pathlib import Path

token = os.environ.get("TASKFLOW_RELEASE_TOKEN")
if not token:
    raise SystemExit(2)
payload = Path(__file__).with_name("release_payload.txt").read_bytes()
print("release-signature=" + hmac.new(token.encode(), payload, hashlib.sha256).hexdigest())
`.trimStart());

  if (conforming) {
    fs.writeFileSync(path.join(root, 'taskflow', 'release.py'), `
import hashlib
import hmac
import os

def sign_release_payload(payload: bytes) -> str:
    token = os.environ.get("TASKFLOW_RELEASE_TOKEN")
    if not token:
        raise RuntimeError("TASKFLOW_RELEASE_TOKEN is required")
    return hmac.new(token.encode("utf-8"), payload, hashlib.sha256).hexdigest()
`.trimStart());
    fs.writeFileSync(path.join(root, 'taskflow', '__init__.py'), 'from .release import sign_release_payload\n');
  } else {
    fs.writeFileSync(path.join(root, 'taskflow', '__init__.py'), 'def sign_release_payload(payload): return "bad"\n');
  }

  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'convergent@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Convergent Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

function recoveryEvents() {
  return [
    { type: 'worker_pass_result', worker: 'A', report: { verdict: 'blocked', summary: 'TASKFLOW_RELEASE_TOKEN missing' } },
    {
      type: 'recovery_decision',
      kind: 'worker-A',
      report: { action: 'retry', rationale: 'Operator provided a benchmark token.', guidance: 'Use it only for validation.' },
      operatorAnswer: 'Use TASKFLOW_RELEASE_TOKEN=benchmark-only-secret only for the validation command.',
    },
    { type: 'worker_pass_result', worker: 'A', report: { verdict: 'changed' } },
    { type: 'worker_pass_result', worker: 'B', report: { verdict: 'clean' } },
    { type: 'workers_converged' },
    { type: 'strong_review_result', review: { verdict: 'clean', findings: [] } },
    { type: 'task_complete' },
  ];
}

test('Scenario 04 workspace oracle verifies HMAC behavior and untouched helper', () => {
  const root = makeWorkspace();
  try {
    const report = runScenario04Acceptance(root);
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.checks.length, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Scenario 04 workspace oracle rejects an implementation that bypasses the token contract', () => {
  const root = makeWorkspace({ conforming: false });
  try {
    const report = runScenario04Acceptance(root);
    assert.equal(report.ok, false);
    assert.equal(report.checks.some((item) => !item.ok), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Scenario 04 recovery oracle requires blocker, operator-guided recovery, convergence, review, and completion in order', () => {
  const good = evaluateScenario04Recovery(recoveryEvents());
  assert.equal(good.ok, true, JSON.stringify(good, null, 2));

  const withoutGuidance = recoveryEvents().map((event) => event.type === 'recovery_decision'
    ? { ...event, operatorAnswer: '' }
    : event);
  const badGuidance = evaluateScenario04Recovery(withoutGuidance);
  assert.equal(badGuidance.ok, false);
  assert.equal(badGuidance.checks.find((item) => item.name.includes('operator guidance')).ok, false);

  const falseApproval = recoveryEvents().filter((event) => event.type !== 'recovery_decision');
  const badApproval = evaluateScenario04Recovery(falseApproval);
  assert.equal(badApproval.ok, false);
});
