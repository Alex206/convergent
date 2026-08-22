#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function pythonExecutable() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function runOracle(workspace) {
  const script = String.raw`
import json
import sys
from taskflow import TaskSpec, select_tasks

def task(name, labels=(), enabled=True):
    return TaskSpec(name, ("echo", name), labels=tuple(labels), enabled=enabled)

tasks = (
    task("first", ("ci", "fast")),
    task("second", ("fast",)),
    task("third", ("ci", "slow"), enabled=False),
    task("fourth", ("ci", "fast")),
)

checks = {}

def names(values):
    return [item.name for item in values]

checks["generator_list_equivalence"] = (
    names(select_tasks(tasks, required_labels=(label for label in ["ci"])))
    == names(select_tasks(tasks, required_labels=["ci"]))
    == ["first", "fourth"]
)
checks["multi_label_generator"] = (
    names(select_tasks(tasks, required_labels=(label for label in ["ci", "fast"])))
    == ["first", "fourth"]
)
checks["duplicate_labels"] = (
    names(select_tasks(tasks, required_labels=(label for label in ["ci", "ci"])))
    == ["first", "fourth"]
)
checks["include_disabled"] = (
    names(select_tasks(tasks, required_labels=(label for label in ["ci"]), include_disabled=True))
    == ["first", "third", "fourth"]
)
checks["stable_order"] = names(select_tasks(tasks, required_labels=())) == ["first", "second", "fourth"]

invalid_cases = [
    "ci",
    [""],
    [1],
    (value for value in ["ci", ""]),
]
invalid_ok = True
for required in invalid_cases:
    try:
        select_tasks(tasks, required_labels=required)
    except ValueError:
        pass
    else:
        invalid_ok = False
checks["invalid_label_validation"] = invalid_ok

print(json.dumps({"ok": all(checks.values()), "checks": checks}, sort_keys=True))
`;
  const stdout = execFileSync(
    pythonExecutable(),
    ['-B', '-c', script],
    { cwd: workspace, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout.trim());
}

function main(argv = process.argv.slice(2)) {
  const workspace = path.resolve(argv[0] ?? '.');
  const output = path.resolve(argv[1] ?? path.join(workspace, 'scenario07-acceptance.json'));
  let result;
  try {
    result = runOracle(workspace);
  } catch (error) {
    result = {
      ok: false,
      error: error?.stderr?.toString?.() || error?.message || String(error),
    };
  }
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { runOracle };
