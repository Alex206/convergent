'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runScenario03Acceptance } = require('../src/headless/scenario03-acceptance');

const GOOD_TASKFLOW = `
from dataclasses import dataclass

class ConfigError(ValueError):
    pass

@dataclass(frozen=True)
class TaskSpec:
    id: str
    command: tuple[str, ...]
    depends_on: tuple[str, ...] = ()

def parse_tasks(items):
    result = []
    for item in items:
        raw = item.get("depends_on", [])
        if not isinstance(raw, list) or any(not isinstance(dep, str) or not dep for dep in raw):
            raise ConfigError(f"invalid depends_on for {item.get('id')}")
        result.append(TaskSpec(id=item["id"], command=tuple(item["command"]), depends_on=tuple(raw)))
    return result

def order_tasks(tasks):
    by_id = {task.id: task for task in tasks}
    for task in tasks:
        for dep in task.depends_on:
            if dep not in by_id:
                raise ConfigError(f"task {task.id} depends on unknown task {dep}")
    emitted = set()
    result = []
    while len(result) < len(tasks):
        progressed = False
        for task in tasks:
            if task.id in emitted:
                continue
            if all(dep in emitted for dep in task.depends_on):
                result.append(task)
                emitted.add(task.id)
                progressed = True
        if not progressed:
            remaining = [task.id for task in tasks if task.id not in emitted]
            raise ConfigError("dependency cycle: " + ", ".join(remaining))
    return result
`;

const BAD_TASKFLOW = `
from dataclasses import dataclass

class ConfigError(ValueError):
    pass

@dataclass(frozen=True)
class TaskSpec:
    id: str
    command: tuple[str, ...]

def parse_tasks(items):
    return [TaskSpec(id=item["id"], command=tuple(item["command"])) for item in items]

def order_tasks(tasks):
    return list(tasks)
`;

async function withPackage(source, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-scenario03-'));
  try {
    const pkg = path.join(root, 'taskflow');
    await fs.mkdir(pkg);
    await fs.writeFile(path.join(pkg, '__init__.py'), source, 'utf8');
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('Scenario 03 acceptance probe passes a conforming implementation', async () => {
  await withPackage(GOOD_TASKFLOW, async (root) => {
    const report = runScenario03Acceptance(root);
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.exitCode, 0);
    assert.equal(report.checks.length, 9);
    assert.equal(report.checks.every((check) => check.ok), true);
  });
});

test('Scenario 03 acceptance probe fails a baseline without dependency support', async () => {
  await withPackage(BAD_TASKFLOW, async (root) => {
    const report = runScenario03Acceptance(root);
    assert.equal(report.ok, false);
    assert.notEqual(report.exitCode, 0);
    assert.equal(report.checks.some((check) => !check.ok), true);
  });
});
