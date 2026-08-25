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
from types import MappingProxyType
from taskflow import merge_metadata

checks = {}

base = {
    "owner": "platform",
    "build": {
        "labels": {"team": "core", "tier": "2"},
        "steps": ["compile", "test"],
    },
    "mode": {"kind": "full"},
}
overrides = {
    "owner": "release",
    "build": {
        "labels": {"tier": "1", "region": "eu"},
    },
    "mode": "fast",
}
base_before = json.loads(json.dumps(base))
overrides_before = json.loads(json.dumps(overrides))
result = merge_metadata(base, overrides)

checks["recursive_merge"] = result["build"]["labels"] == {
    "team": "core", "tier": "1", "region": "eu"
}
checks["base_only_nested_preserved"] = result["build"]["steps"] == ["compile", "test"]
checks["non_mapping_replacement"] = result["mode"] == "fast"
checks["override_scalar"] = result["owner"] == "release"
checks["inputs_unchanged_during_merge"] = base == base_before and overrides == overrides_before

result["build"]["labels"]["team"] = "mutated"
checks["base_nested_mapping_isolated"] = base["build"]["labels"]["team"] == "core"
result["build"]["labels"]["region"] = "mutated"
checks["override_nested_mapping_isolated"] = overrides["build"]["labels"]["region"] == "eu"
result["build"]["steps"].append("publish")
checks["base_nested_list_isolated"] = base["build"]["steps"] == ["compile", "test"]

list_override = {"build": {"steps": ["package"]}}
list_result = merge_metadata({"build": {"labels": {"a": "b"}}}, list_override)
list_result["build"]["steps"].append("ship")
checks["override_nested_list_isolated"] = list_override["build"]["steps"] == ["package"]

proxy_base_inner = MappingProxyType({"left": 1})
proxy_override_inner = MappingProxyType({"right": 2})
proxy_result = merge_metadata(
    MappingProxyType({"nested": proxy_base_inner}),
    MappingProxyType({"nested": proxy_override_inner}),
)
checks["general_mapping_compatibility"] = proxy_result == {"nested": {"left": 1, "right": 2}}
checks["returns_plain_dict"] = isinstance(proxy_result, dict) and isinstance(proxy_result["nested"], dict)

result = {"ok": all(checks.values()), "checks": checks}
print(json.dumps(result, sort_keys=True))
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
  const output = path.resolve(argv[1] ?? path.join(workspace, 'scenario09-acceptance.json'));
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
