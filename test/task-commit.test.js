'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isWorkingTreeClean, commitSubject, createTaskCommit } = require('../src/orchestrator/task-commit');

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function tempRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'convergent-task-commit-'));
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'convergent-test@example.invalid');
  git(repo, 'config', 'user.name', 'Convergent Test');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'base');
  return repo;
}

test('safe task commit turns accepted task changes into the next clean HEAD baseline', async (t) => {
  const repo = tempRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  assert.equal(await isWorkingTreeClean(repo), true);

  fs.writeFileSync(path.join(repo, 'base.txt'), 'changed by task\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new task file\n');
  assert.equal(await isWorkingTreeClean(repo), false);

  const sha = await createTaskCommit(repo, { id: 'T2', title: 'Implement feature' });

  assert.equal(sha, git(repo, 'rev-parse', 'HEAD'));
  assert.equal(await isWorkingTreeClean(repo), true);
  assert.match(git(repo, 'log', '-1', '--pretty=%s'), /^convergent: T2 Implement feature$/);
});

test('task commit helper is a no-op when there is nothing to commit', async (t) => {
  const repo = tempRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  assert.equal(await createTaskCommit(repo, { id: 'T1', title: 'Nothing' }), null);
});

test('task commit subjects are single-line and bounded', () => {
  const subject = commitSubject({ id: 'T1\nunsafe', title: 'A\nB'.repeat(200) });
  assert.equal(subject.includes('\n'), false);
  assert.ok(subject.length <= 180);
});
