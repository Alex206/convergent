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


def task(name, depends_on=None):
    data = {"name": name, "command": ["echo", name]}
    if depends_on is not None:
        data["depends_on"] = depends_on
    return data


def assert_default():
    spec = TaskSpec(name="a", command=("echo", "a"))
    assert hasattr(spec, "depends_on"), "TaskSpec.depends_on is missing"
    assert spec.depends_on == (), f"expected default (), got {spec.depends_on!r}"
    assert isinstance(spec.depends_on, tuple), type(spec.depends_on).__name__


def assert_parse_absent():
    parsed = parse_tasks([task("a")])
    assert parsed[0].depends_on == (), parsed[0].depends_on


def assert_parse_dependencies():
    parsed = parse_tasks([task("a"), task("b", ["a"])])
    assert parsed[1].depends_on == ("a",), parsed[1].depends_on
    assert isinstance(parsed[1].depends_on, tuple), type(parsed[1].depends_on).__name__


def assert_invalid_dep_shapes():
    bad_values = [None, "a", b"a", [""], ["   "], [1], ["a", ""]]
    for value in bad_values:
        data = {"name": "b", "command": ["echo", "b"], "depends_on": value}
        try:
            parse_tasks([data])
        except ConfigError:
            continue
        raise AssertionError(f"depends_on={value!r} did not raise ConfigError")


def assert_duplicate_dependencies():
    try:
        parse_tasks([task("a"), task("b", ["a", "a"])])
    except ConfigError as exc:
        text = str(exc).lower()
        assert "depend" in text and ("duplicate" in text or "a" in text), text
        return
    raise AssertionError("duplicate dependencies did not raise ConfigError")


def assert_self_dependency():
    try:
        parse_tasks([task("a", ["a"])])
    except ConfigError as exc:
        text = str(exc).lower()
        assert "a" in text and "depend" in text, text
        return
    raise AssertionError("self dependency did not raise ConfigError")


def assert_unknown_dependency():
    try:
        parse_tasks([task("b", ["missing"])])
    except ConfigError as exc:
        text = str(exc)
        assert "b" in text and "missing" in text, text
        return
    raise AssertionError("parse_tasks accepted an unknown dependency")


def assert_cycle():
    tasks = parse_tasks([task("a", ["b"]), task("b", ["a"])])
    try:
        order_tasks(tasks)
    except ConfigError as exc:
        text = str(exc).lower()
        assert "cycle" in text, text
        assert "a" in text and "b" in text, text
        return
    raise AssertionError("dependency cycle did not raise ConfigError")


def names(items):
    return [item.name for item in items]


def assert_simple_chain():
    tasks = parse_tasks([task("build"), task("test", ["build"]), task("publish", ["test"])])
    assert names(order_tasks(tasks)) == ["build", "test", "publish"]


def assert_branching_stability():
    tasks = parse_tasks([
        task("a"),
        task("b"),
        task("c", ["a"]),
        task("d", ["b"]),
        task("e", ["c", "d"]),
    ])
    ordered = names(order_tasks(tasks))
    assert ordered == ["a", "b", "c", "d", "e"], ordered


def assert_unconstrained_input_order():
    tasks = parse_tasks([
        task("z"),
        task("dependent", ["base"]),
        task("a"),
        task("base"),
        task("m"),
    ])
    ordered = names(order_tasks(tasks))
    assert ordered == ["z", "a", "base", "dependent", "m"], ordered


def assert_exports():
    import taskflow
    assert taskflow.TaskSpec is TaskSpec
    assert taskflow.ConfigError is ConfigError
    assert taskflow.parse_tasks is parse_tasks
    assert taskflow.order_tasks is order_tasks


check("TaskSpec.depends_on immutable tuple default", assert_default)
check("parse absent depends_on", assert_parse_absent)
check("parse dependency sequence to tuple", assert_parse_dependencies)
check("reject invalid depends_on shapes", assert_invalid_dep_shapes)
check("reject duplicate dependencies", assert_duplicate_dependencies)
check("reject self dependencies", assert_self_dependency)
check("parse_tasks rejects unknown dependencies", assert_unknown_dependency)
check("cycle error names involved tasks", assert_cycle)
check("simple dependency chain", assert_simple_chain)
check("branching dependency order is deterministic", assert_branching_stability)
check("unconstrained tasks preserve input order", assert_unconstrained_input_order)
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
