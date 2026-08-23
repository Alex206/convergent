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
from taskflow import parse_duration

checks = {}

valid_cases = {
    "30s": 30,
    "5m": 300,
    "2h": 7200,
    "  1h  ": 3600,
    "\t7m\n": 420,
}
checks["valid_and_surrounding_whitespace"] = all(
    parse_duration(text) == expected for text, expected in valid_cases.items()
)

invalid_cases = (
    "0s",
    "-1m",
    "30",
    "5d",
    "2H",
    "",
    "   ",
    "1.5h",
    "5 m",
    "2\th",
    "1\nh",
)
invalid_ok = True
for text in invalid_cases:
    try:
        parse_duration(text)
    except ValueError:
        pass
    else:
        invalid_ok = False
checks["invalid_and_internal_whitespace_rejected"] = invalid_ok

checks["public_export"] = callable(parse_duration)

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
  const output = path.resolve(argv[1] ?? path.join(workspace, 'scenario01-acceptance.json'));
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
