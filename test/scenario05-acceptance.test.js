'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  SETTINGS,
  NOTE,
  evaluateProtectedWorkspaceState,
  runScenario05Acceptance,
} = require('../src/headless/scenario05-acceptance');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convergent-s05-'));
  fs.mkdirSync(path.join(root, 'taskflow'));
  fs.mkdirSync(path.join(root, '.vscode'));
  fs.writeFileSync(path.join(root, '.gitignore'), 'notes.local\n');
  fs.writeFileSync(path.join(root, 'taskflow', '__init__.py'), `
from dataclasses import dataclass

@dataclass(frozen=True)
class TaskSpec:
    name: str
    command: tuple[str, ...]
    labels: tuple[str, ...] = ()

def has_label(task: TaskSpec, label: str) -> bool:
    return label in task.labels
`.trimStart());
  fs.writeFileSync(path.join(root, '.vscode', 'settings.json'), SETTINGS);
  fs.writeFileSync(path.join(root, 'notes.local'), NOTE);

  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'convergent@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Convergent Test'], { cwd: root });
  execFileSync('git', ['add', '.gitignore', 'taskflow/__init__.py'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

test('Scenario 05 oracle accepts exact helper behavior while preserving untracked and ignored user state', () => {
  const root = makeWorkspace();
  try {
    const report = runScenario05Acceptance(root);
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.behavior.checks.length, 3);
    assert.equal(report.workspaceState.checks.length, 6);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Scenario 05 workspace oracle detects modified or removed pre-existing user state', () => {
  const root = makeWorkspace();
  try {
    fs.writeFileSync(path.join(root, '.vscode', 'settings.json'), '{"changed":true}\n');
    fs.rmSync(path.join(root, 'notes.local'));
    const report = evaluateProtectedWorkspaceState(root);
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((item) => item.name.includes('settings.json')).ok, false);
    assert.equal(report.checks.find((item) => item.name.includes('notes.local remains byte')).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
