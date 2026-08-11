'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runScenario03Acceptance } = require('../src/headless/scenario03-acceptance');

const GOOD_TASKFLOW = `
from collections.abc import Sequence
from dataclasses import dataclass

class ConfigError(ValueError):
    pass

@dataclass(frozen=True)
class TaskSpec:
    name: str
    command: tuple[str, ...]
    depends_on: tuple[str, ...] = ()

def parse_tasks(items):
    result = []
    names = set()
    for item in items:
        name = item["name"]
        if name in names:
            raise ConfigError(f"duplicate task name: {name}")
        names.add(name)
        if "depends_on" not in item:
            raw = ()
        else:
            raw = item["depends_on"]
            if isinstance(raw, (str, bytes)) or not isinstance(raw, Sequence):
                raise ConfigError(f"depends_on for {name} must be a sequence")
        dependencies = []
        seen = set()
        for dep in raw:
            if not isinstance(dep, str) or not dep.strip():
                raise ConfigError(f"depends_on for {name} must contain non-empty strings")
            dep = dep.strip()
            if dep in seen:
                raise ConfigError(f"duplicate dependency for {name}: {dep}")
            if dep == name:
                raise ConfigError(f"task {name} cannot depend on itself")
            seen.add(dep)
            dependencies.append(dep)
        result.append(TaskSpec(name=name, command=tuple(item["command"]), depends_on=tuple(dependencies)))
    known = {task.name for task in result}
    for task in result:
        for dep in task.depends_on:
            if dep not in known:
                raise ConfigError(f"task {task.name} depends on unknown task {dep}")
    return tuple(result)

def order_tasks(tasks):
    by_name = {task.name: task for task in tasks}
    index = {task.name: position for position, task in enumerate(tasks)}
    dependents = {task.name: [] for task in tasks}
    indegree = {task.name: len(task.depends_on) for task in tasks}
    for task in tasks:
        for dep in task.depends_on:
            dependents[dep].append(task.name)

    available = [task.name for task in tasks if indegree[task.name] == 0]
    available.sort(key=index.__getitem__)
    result = []
    while available:
        name = available.pop(0)
        result.append(by_name[name])
        for dependent in dependents[name]:
            indegree[dependent] -= 1
            if indegree[dependent] == 0:
                available.append(dependent)
        available.sort(key=index.__getitem__)

    if len(result) != len(tasks):
        remaining = [task.name for task in tasks if indegree[task.name] > 0]
        raise ConfigError("dependency cycle: " + ", ".join(remaining))
    return tuple(result)
`;

const BAD_TASKFLOW = `
from dataclasses import dataclass

class ConfigError(ValueError):
    pass

@dataclass(frozen=True)
class TaskSpec:
    name: str
    command: tuple[str, ...]

def parse_tasks(items):
    return tuple(TaskSpec(name=item["name"], command=tuple(item["command"])) for item in items)

def order_tasks(tasks):
    return tuple(tasks)
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
    assert.equal(report.checks.length, 12);
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
