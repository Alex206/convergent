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
from taskflow import run_in_workspace

checks = {}

class CallbackError(RuntimeError):
    pass

class CleanupError(OSError):
    pass

class Abort(BaseException):
    pass

calls = []
marker = object()

def success_callback(workspace):
    calls.append(("callback", workspace.exists()))
    return marker

def success_cleanup(workspace):
    calls.append(("cleanup", workspace.exists()))

returned = run_in_workspace(success_callback, success_cleanup)
checks["success_result_identity"] = returned is marker
checks["success_cleanup_once"] = [name for name, _ in calls] == ["callback", "cleanup"]
checks["workspace_exists_during_success_cleanup"] = all(exists for _, exists in calls)

calls = []
callback_error = CallbackError("callback failed")
def failing_callback(workspace):
    calls.append("callback")
    raise callback_error

def recording_cleanup(workspace):
    calls.append("cleanup")

try:
    run_in_workspace(failing_callback, recording_cleanup)
except BaseException as exc:
    checks["callback_failure_primary"] = type(exc) is CallbackError and str(exc) == "callback failed"
else:
    checks["callback_failure_primary"] = False
checks["callback_failure_cleanup_once"] = calls == ["callback", "cleanup"]

cleanup_error = CleanupError("cleanup failed")
def cleanup_only_failure(workspace):
    raise cleanup_error
try:
    run_in_workspace(lambda workspace: "ok", cleanup_only_failure)
except BaseException as exc:
    checks["cleanup_failure_after_success"] = type(exc) is CleanupError and str(exc) == "cleanup failed"
else:
    checks["cleanup_failure_after_success"] = False

calls = []
combined_callback_error = CallbackError("primary callback failure")
combined_cleanup_error = CleanupError("secondary cleanup failure")
def combined_callback(workspace):
    calls.append("callback")
    raise combined_callback_error

def combined_cleanup(workspace):
    calls.append("cleanup")
    raise combined_cleanup_error

try:
    run_in_workspace(combined_callback, combined_cleanup)
except BaseException as exc:
    checks["combined_primary_preserved"] = type(exc) is CallbackError and str(exc) == "primary callback failure"
    chain = []
    seen = set()
    current = exc.__cause__ or exc.__context__
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        chain.append(current)
        current = current.__cause__ or current.__context__
    checks["combined_cleanup_inspectable"] = any(
        type(item) is CleanupError and str(item) == "secondary cleanup failure"
        for item in chain
    )
else:
    checks["combined_primary_preserved"] = False
    checks["combined_cleanup_inspectable"] = False
checks["combined_cleanup_once"] = calls == ["callback", "cleanup"]

calls = []
abort = Abort("stop now")
def abort_callback(workspace):
    calls.append("callback")
    raise abort

def abort_cleanup(workspace):
    calls.append("cleanup")

try:
    run_in_workspace(abort_callback, abort_cleanup)
except BaseException as exc:
    checks["baseexception_primary_preserved"] = type(exc) is Abort and str(exc) == "stop now"
else:
    checks["baseexception_primary_preserved"] = False
checks["baseexception_cleanup_once"] = calls == ["callback", "cleanup"]

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
  const output = path.resolve(argv[1] ?? path.join(workspace, 'scenario10-acceptance.json'));
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
