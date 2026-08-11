'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROBE = String.raw`
import json
import sys

result = {"checks": []}

def check(name, fn):
    try:
        fn()
        result["checks"].append({"name": name, "ok": True})
    except Exception as exc:
        result["checks"].append({"name": name, "ok": False, "error": f"{type(exc).__name__}: {exc}"})

from taskflow import ConfigError, TaskSpec, order_tasks, parse_tasks


def assert_default():
    spec = TaskSpec(id="a", command=("echo", "a"))
    assert hasattr(spec, "depends_on"), "TaskSpec.depends_on is missing"
    assert spec.depends_on == (), f"expected default (), got {spec.depends_on!r}"


def assert_parse_absent():
    parsed = parse_tasks([{"id": "a", "command": ["echo", "a"]}])
    assert parsed[0].depends_on == (), parsed[0].depends_on


def assert_parse_dependencies():
    parsed = parse_tasks([
        {"id": "a", "command": ["echo", "a"]},
        {"id": "b", "command": ["echo", "b"], "depends_on": ["a"]},
    ])
    assert parsed[1].depends_on == ("a",), parsed[1].depends_on


def assert_invalid_dep_shapes():
    bad_values = ["a", [""], [1], ["a", ""]]
    for value in bad_values:
        try:
            parse_tasks([{"id": "b", "command": ["echo", "b"], "depends_on": value}])
        except ConfigError:
            continue
        raise AssertionError(f"depends_on={value!r} did not raise ConfigError")


def assert_unknown_dependency():
    tasks = parse_tasks([{"id": "b", "command": ["echo", "b"], "depends_on": ["missing"]}])
    try:
        order_tasks(tasks)
    except ConfigError as exc:
        text = str(exc)
        assert "b" in text and "missing" in text, text
        return
    raise AssertionError("unknown dependency did not raise ConfigError")


def assert_cycle():
    tasks = parse_tasks([
        {"id": "a", "command": ["echo", "a"], "depends_on": ["b"]},
        {"id": "b", "command": ["echo", "b"], "depends_on": ["a"]},
    ])
    try:
        order_tasks(tasks)
    except ConfigError as exc:
        text = str(exc)
        assert "a" in text and "b" in text, text
        return
    raise AssertionError("dependency cycle did not raise ConfigError")


def ids(items):
    return [item.id for item in items]


def assert_stable_order():
    tasks = parse_tasks([
        {"id": "a", "command": ["echo", "a"]},
        {"id": "b", "command": ["echo", "b"]},
        {"id": "c", "command": ["echo", "c"], "depends_on": ["a"]},
        {"id": "d", "command": ["echo", "d"], "depends_on": ["b"]},
        {"id": "e", "command": ["echo", "e"], "depends_on": ["c", "d"]},
    ])
    ordered = ids(order_tasks(tasks))
    assert ordered == ["a", "b", "c", "d", "e"], ordered


def assert_independent_stability():
    tasks = parse_tasks([
        {"id": "z", "command": ["echo", "z"]},
        {"id": "a", "command": ["echo", "a"]},
        {"id": "m", "command": ["echo", "m"]},
    ])
    assert ids(order_tasks(tasks)) == ["z", "a", "m"]


def assert_exports():
    import taskflow
    assert taskflow.TaskSpec is TaskSpec
    assert taskflow.ConfigError is ConfigError
    assert taskflow.parse_tasks is parse_tasks
    assert taskflow.order_tasks is order_tasks


check("TaskSpec.depends_on default", assert_default)
check("parse absent depends_on", assert_parse_absent)
check("parse dependency list", assert_parse_dependencies)
check("reject invalid depends_on shapes", assert_invalid_dep_shapes)
check("unknown dependency error names ids", assert_unknown_dependency)
check("cycle error names involved ids", assert_cycle)
check("stable topological ordering", assert_stable_order)
check("independent tasks preserve input order", assert_independent_stability)
check("public exports", assert_exports)

result["ok"] = all(item["ok"] for item in result["checks"])
print(json.dumps(result, indent=2))
sys.exit(0 if result["ok"] else 1)
`;

function runScenario03Acceptance(workspace, { python = process.platform === 'win32' ? 'python' : 'python3' } = {}) {
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
  const [workspace, output] = argv;
  if (!workspace) {
    console.error('Usage: node src/headless/scenario03-acceptance.js <workspace> [output.json]');
    return 2;
  }
  const report = runScenario03Acceptance(workspace);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(path.resolve(output), json, 'utf8');
  }
  process.stdout.write(json);
  return report.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { PROBE, runScenario03Acceptance, main };
