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
import os
import tempfile
from pathlib import Path
from taskflow import resolve_artifact_path

checks = {}
skipped = {}

with tempfile.TemporaryDirectory() as td:
    base = Path(td).resolve()
    root = base / "work"
    sibling = base / "work-shadow"
    outside = base / "outside"
    root.mkdir()
    sibling.mkdir()
    outside.mkdir()
    (root / "reports").mkdir()
    (sibling / "leak.txt").write_text("leak", encoding="utf-8")
    (outside / "leak.txt").write_text("leak", encoding="utf-8")

    def rejects(value):
        try:
            resolve_artifact_path(root, value)
        except ValueError:
            return True
        return False

    valid = resolve_artifact_path(root, "reports/../result.json")
    checks["normalized_in_root"] = valid == (root / "result.json").resolve()
    checks["canonical_return"] = valid == valid.resolve()
    lexical_reentry = resolve_artifact_path(root, f"../{root.name}/reentered.txt")
    checks["normalized_reentry_in_root"] = lexical_reentry == (root / "reentered.txt").resolve()
    checks["sibling_prefix_traversal"] = rejects("../work-shadow/leak.txt")
    checks["absolute_inside_root"] = rejects(str((root / "result.json").resolve()))
    checks["root_self_dot"] = rejects(".")
    checks["root_self_normalized"] = rejects("reports/..")
    checks["empty_path"] = rejects("")

    symlink = root / "escape"
    try:
        symlink.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        skipped["symlink_escape"] = str(exc)
        skipped["symlink_escape_reentry"] = str(exc)
    else:
        checks["symlink_escape"] = rejects("escape/leak.txt")
        checks["symlink_escape_reentry"] = rejects(f"escape/../{root.name}/reentered.txt")

    sibling_link = root / "sibling-link"
    try:
        sibling_link.symlink_to(sibling, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        skipped["sibling_prefix_symlink"] = str(exc)
    else:
        checks["sibling_prefix_symlink"] = rejects("sibling-link/leak.txt")

result = {
    "ok": all(checks.values()),
    "checks": checks,
    "skipped": skipped,
}
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
  const output = path.resolve(argv[1] ?? path.join(workspace, 'scenario08-acceptance.json'));
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
