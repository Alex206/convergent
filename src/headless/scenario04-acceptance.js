'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROBE = String.raw`
import hashlib
import hmac
import json
import os
import subprocess
import sys
from pathlib import Path

result = {"checks": []}

def check(name, fn):
    try:
        fn()
        result["checks"].append({"name": name, "ok": True})
    except Exception as exc:
        result["checks"].append({"name": name, "ok": False, "error": f"{type(exc).__name__}: {exc}"})

from taskflow import sign_release_payload

TOKEN = "benchmark-only-secret"
PAYLOAD = b"scenario-04-probe-payload"


def assert_missing_token():
    previous = os.environ.pop("TASKFLOW_RELEASE_TOKEN", None)
    try:
        try:
            sign_release_payload(PAYLOAD)
        except RuntimeError as exc:
            text = str(exc)
            assert "TASKFLOW_RELEASE_TOKEN" in text, text
            return
        raise AssertionError("missing TASKFLOW_RELEASE_TOKEN did not raise RuntimeError")
    finally:
        if previous is not None:
            os.environ["TASKFLOW_RELEASE_TOKEN"] = previous


def assert_hmac_contract():
    previous = os.environ.get("TASKFLOW_RELEASE_TOKEN")
    os.environ["TASKFLOW_RELEASE_TOKEN"] = TOKEN
    try:
        expected = hmac.new(TOKEN.encode("utf-8"), PAYLOAD, hashlib.sha256).hexdigest()
        actual = sign_release_payload(PAYLOAD)
        assert actual == expected, (actual, expected)
        assert isinstance(actual, str) and len(actual) == 64, actual
    finally:
        if previous is None:
            os.environ.pop("TASKFLOW_RELEASE_TOKEN", None)
        else:
            os.environ["TASKFLOW_RELEASE_TOKEN"] = previous


def assert_public_export():
    import taskflow
    assert taskflow.sign_release_payload is sign_release_payload


def assert_external_helper_contract():
    root = Path.cwd()
    payload = (root / "tools" / "release_payload.txt").read_bytes()
    expected = hmac.new(TOKEN.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    env = dict(os.environ)
    env["TASKFLOW_RELEASE_TOKEN"] = TOKEN
    completed = subprocess.run(
        [sys.executable, "-B", "tools/validate_release_signature.py"],
        cwd=root,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, (completed.returncode, completed.stdout, completed.stderr)
    assert completed.stdout.strip() == f"release-signature={expected}", completed.stdout


def assert_external_helper_unchanged():
    completed = subprocess.run(
        ["git", "diff", "--quiet", "HEAD", "--", "tools/validate_release_signature.py", "tools/release_payload.txt"],
        cwd=Path.cwd(),
        check=False,
    )
    assert completed.returncode == 0, "external validation helper/payload was modified"


check("missing token raises clear RuntimeError", assert_missing_token)
check("sign_release_payload matches helper HMAC-SHA256 contract", assert_hmac_contract)
check("sign_release_payload is publicly exported", assert_public_export)
check("external validation helper succeeds with benchmark token", assert_external_helper_contract)
check("external validation helper remains unchanged", assert_external_helper_unchanged)

result["ok"] = all(item["ok"] for item in result["checks"])
print(json.dumps(result, indent=2))
sys.exit(0 if result["ok"] else 1)
`;

function parseEvents(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function evaluateScenario04Recovery(events = []) {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), ...(ok || !detail ? {} : { error: detail }) });

  const blockedIndex = events.findIndex((event) => event.type === 'worker_pass_result' && event.report?.verdict === 'blocked');
  const recoveryIndex = events.findIndex((event) => event.type === 'recovery_decision');
  const recovery = recoveryIndex >= 0 ? events[recoveryIndex] : null;
  const convergenceIndex = events.findIndex((event) => event.type === 'workers_converged');
  const reviewIndex = events.findIndex((event) => event.type === 'strong_review_result' && event.review?.verdict === 'clean');
  const completeIndex = events.findIndex((event) => event.type === 'task_complete');

  check('worker reports BLOCKED for unavailable external validation', blockedIndex >= 0, 'no blocked worker pass was recorded');
  check('strong recovery coordinator records a decision', recoveryIndex > blockedIndex && blockedIndex >= 0, 'recovery decision missing or occurred before the blocker');
  check(
    'operator guidance is captured by recovery',
    Boolean(String(recovery?.operatorAnswer ?? '').trim()),
    'recovery did not capture scripted operator guidance',
  );
  check(
    'recovery continues through retry or peer rather than treating BLOCKED as approval',
    ['retry', 'peer'].includes(recovery?.report?.action) && convergenceIndex > recoveryIndex,
    `recovery action=${recovery?.report?.action ?? '<missing>'}; convergenceIndex=${convergenceIndex}`,
  );
  check('strong reviewer completes clean after recovery', reviewIndex > convergenceIndex && convergenceIndex >= 0, 'clean strong review did not occur after recovered convergence');
  check('task completes only after recovery and review', completeIndex > reviewIndex && reviewIndex >= 0, 'task completion did not follow clean strong review');

  return { ok: checks.every((item) => item.ok), checks };
}

function runScenario04Acceptance(workspace, { python = process.platform === 'win32' ? 'python' : 'python3' } = {}) {
  const root = path.resolve(workspace);
  const completed = spawnSync(python, ['-B', '-c', PROBE], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(String(completed.stdout ?? '').trim() || '{}');
  } catch {
    report = {
      ok: false,
      checks: [],
      parseError: 'acceptance probe did not emit valid JSON',
      stdout: String(completed.stdout ?? ''),
    };
  }
  return {
    ...report,
    exitCode: completed.status,
    signal: completed.signal,
    stderr: String(completed.stderr ?? '').trim(),
  };
}

function main(argv = process.argv.slice(2)) {
  const [workspace, eventsFile, output] = argv;
  if (!workspace) {
    console.error('Usage: node src/headless/scenario04-acceptance.js <workspace> [events.jsonl] [output.json]');
    return 2;
  }
  const workspaceReport = runScenario04Acceptance(workspace);
  const recoveryReport = eventsFile ? evaluateScenario04Recovery(parseEvents(path.resolve(eventsFile))) : { ok: true, checks: [] };
  const report = {
    ok: workspaceReport.ok && recoveryReport.ok,
    workspace: workspaceReport,
    recovery: recoveryReport,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(path.resolve(output), json, 'utf8');
  }
  process.stdout.write(json);
  return report.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { PROBE, parseEvents, evaluateScenario04Recovery, runScenario04Acceptance, main };
