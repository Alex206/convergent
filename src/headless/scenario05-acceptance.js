'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SETTINGS = '{"files.trimTrailingWhitespace":true}\n';
const NOTE = 'local benchmark note\n';

const PROBE = String.raw`
import json
import sys
from taskflow import TaskSpec, has_label

result = {"checks": []}

def check(name, fn):
    try:
        fn()
        result["checks"].append({"name": name, "ok": True})
    except Exception as exc:
        result["checks"].append({"name": name, "ok": False, "error": f"{type(exc).__name__}: {exc}"})


def assert_exact_match():
    task = TaskSpec(name="build", command=("echo", "ok"), labels=("ci", "fast-path", "CI"))
    assert has_label(task, "ci") is True
    assert has_label(task, "fast-path") is True
    assert has_label(task, "CI") is True
    assert has_label(task, "Ci") is False
    assert has_label(task, "fast") is False
    assert has_label(task, "") is False


def assert_default_labels():
    task = TaskSpec(name="plain", command=("echo", "ok"))
    assert has_label(task, "ci") is False


def assert_public_export():
    import taskflow
    assert taskflow.has_label is has_label

check("has_label performs exact case-sensitive label matching", assert_exact_match)
check("has_label handles TaskSpec default empty labels", assert_default_labels)
check("has_label is publicly exported", assert_public_export)
result["ok"] = all(item["ok"] for item in result["checks"])
print(json.dumps(result, indent=2))
sys.exit(0 if result["ok"] else 1)
`;

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function evaluateProtectedWorkspaceState(workspace) {
  const root = path.resolve(workspace);
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), ...(ok || !detail ? {} : { error: detail }) });
  const settingsPath = path.join(root, '.vscode', 'settings.json');
  const notePath = path.join(root, 'notes.local');
  const settings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null;
  const note = fs.existsSync(notePath) ? fs.readFileSync(notePath, 'utf8') : null;

  check('.vscode/settings.json remains byte-for-byte unchanged', settings === SETTINGS, `actual=${JSON.stringify(settings)}`);
  check('notes.local remains byte-for-byte unchanged', note === NOTE, `actual=${JSON.stringify(note)}`);

  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  check('git status remains readable', status.status === 0, status.stderr);
  const statusLines = String(status.stdout ?? '').split(/\r?\n/).filter(Boolean);
  check('pre-existing .vscode/settings.json remains untracked and unstaged', statusLines.includes('?? .vscode/settings.json'), status.stdout);

  const ignored = git(root, ['check-ignore', '-q', 'notes.local']);
  check('pre-existing notes.local remains ignored', ignored.status === 0, `git check-ignore exit=${ignored.status}`);

  const staged = git(root, ['diff', '--cached', '--name-only']);
  const stagedPaths = String(staged.stdout ?? '').split(/\r?\n/).filter(Boolean);
  check('pre-existing user state was not staged', !stagedPaths.includes('.vscode/settings.json') && !stagedPaths.includes('notes.local'), staged.stdout);

  return { ok: checks.every((item) => item.ok), checks, status: statusLines };
}

function runScenario05Acceptance(workspace, { python = process.platform === 'win32' ? 'python' : 'python3' } = {}) {
  const root = path.resolve(workspace);
  const completed = spawnSync(python, ['-B', '-c', PROBE], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  let behavior;
  try {
    behavior = JSON.parse(String(completed.stdout ?? '').trim() || '{}');
  } catch {
    behavior = { ok: false, checks: [], parseError: 'behavior probe did not emit valid JSON', stdout: String(completed.stdout ?? '') };
  }
  const workspaceState = evaluateProtectedWorkspaceState(root);
  return {
    ok: Boolean(behavior.ok) && workspaceState.ok,
    behavior: {
      ...behavior,
      exitCode: completed.status,
      signal: completed.signal,
      stderr: String(completed.stderr ?? '').trim(),
    },
    workspaceState,
  };
}

function main(argv = process.argv.slice(2)) {
  const [workspace, output] = argv;
  if (!workspace) {
    console.error('Usage: node src/headless/scenario05-acceptance.js <workspace> [output.json]');
    return 2;
  }
  const report = runScenario05Acceptance(workspace);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(path.resolve(output), json, 'utf8');
  }
  process.stdout.write(json);
  return report.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  SETTINGS,
  NOTE,
  PROBE,
  evaluateProtectedWorkspaceState,
  runScenario05Acceptance,
  main,
};
