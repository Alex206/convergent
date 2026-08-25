#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runOracle: runScenario08 } = require('./scenario08-acceptance');
const { runOracle: runScenario09 } = require('./scenario09-acceptance');
const { runOracle: runScenario10 } = require('./scenario10-acceptance');

function pythonExecutable() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function expectedSingleFalse(checks, expectedFalse) {
  const falseKeys = Object.entries(checks ?? {}).filter(([, value]) => value === false).map(([key]) => key);
  return falseKeys.length === 1 && falseKeys[0] === expectedFalse;
}

function runPythonProbe(workspace, script) {
  const stdout = execFileSync(pythonExecutable(), ['-B', '-c', script], {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
}

function validateMappingProxyDefect(workspace) {
  return runPythonProbe(workspace, String.raw`
import json
from types import MappingProxyType
from taskflow import merge_metadata
try:
    merge_metadata(
        MappingProxyType({"nested": MappingProxyType({"left": 1})}),
        MappingProxyType({"other": 2}),
    )
except TypeError as exc:
    print(json.dumps({"failed_as_expected": True, "type": type(exc).__name__, "message": str(exc)}))
else:
    print(json.dumps({"failed_as_expected": False}))
`);
}

function validateTimeoutContract(workspace) {
  return runPythonProbe(workspace, String.raw`
import json
from taskflow.timeout import normalize_timeout

def raises_value_error(value):
    try:
        normalize_timeout(value)
    except ValueError:
        return True
    except BaseException:
        return False
    return False

checks = {
    "valid_values": (
        normalize_timeout(0) == 0
        and normalize_timeout(1) == 1
        and normalize_timeout(600) == 600
        and normalize_timeout("0") == 0
        and normalize_timeout("0007") == 7
        and normalize_timeout("600") == 600
    ),
    "invalid_syntax_and_types": all(raises_value_error(v) for v in (
        "", " 42", "42 ", "+42", "-1", "4.2", "１２", None, 1.5, [], {}
    )),
    "range_enforced": all(raises_value_error(v) for v in (-1, 601, "601")),
    "bool_rejected": raises_value_error(True) and raises_value_error(False),
}
print(json.dumps({"checks": checks}))
`);
}

function validateArchiveContract(workspace) {
  return runPythonProbe(workspace, String.raw`
import json
from taskflow.archive import normalize_archive_member

def raises_value_error(value):
    try:
        normalize_archive_member(value)
    except ValueError:
        return True
    except BaseException:
        return False
    return False

checks = {
    "posix_semantics": (
        normalize_archive_member("reports/result.json") == "reports/result.json"
        and normalize_archive_member("reports/./daily.json") == "reports/daily.json"
        and normalize_archive_member("reports//daily.json") == "reports/daily.json"
        and all(raises_value_error(v) for v in ("", ".", "/etc/passwd", "../secret.txt", "reports/../../secret.txt"))
    ),
    "backslash_separator_semantics": (
        normalize_archive_member(r"reports\\result.json") == "reports/result.json"
        and normalize_archive_member(r"reports\\.\\daily.json") == "reports/daily.json"
        and raises_value_error(r"..\\secret.txt")
        and raises_value_error(r"reports\\..\\secret.txt")
        and raises_value_error(r"\\absolute\\secret.txt")
    ),
}
print(json.dumps({"checks": checks}))
`);
}

function validateFrameContract(workspace) {
  return runPythonProbe(workspace, String.raw`
import json
from taskflow.framing import pop_frame

checks = {}

buf = bytearray()
checks["empty"] = pop_frame(buf) is None and buf == bytearray()

buf = bytearray([3]) + bytearray(b"abcTAIL")
checks["complete"] = pop_frame(buf) == b"abc" and buf == bytearray(b"TAIL")

buf = bytearray([0]) + bytearray(b"tail")
checks["zero_length"] = pop_frame(buf) == b"" and buf == bytearray(b"tail")

buf = bytearray([1]) + bytearray(b"a") + bytearray([2]) + bytearray(b"bc")
checks["multiple_frames"] = (
    pop_frame(buf) == b"a"
    and pop_frame(buf) == b"bc"
    and buf == bytearray()
)

buf = bytearray([4]) + bytearray(b"ab")
before = bytes(buf)
result = pop_frame(buf)
checks["incomplete_non_destructive"] = result is None and bytes(buf) == before

print(json.dumps({"checks": checks}))
`);
}

function validateCase(caseId, workspace) {
  if (caseId === 's08-symlink-reentry') {
    const oracle = runScenario08(workspace);
    return {
      valid: oracle.ok === false && expectedSingleFalse(oracle.checks, 'symlink_escape_reentry'),
      expectedDefect: true,
      expectedDefectId: 'symlink_escape_reentry',
      oracle,
    };
  }
  if (caseId === 's09-mappingproxy') {
    const probe = validateMappingProxyDefect(workspace);
    return {
      valid: probe.failed_as_expected === true,
      expectedDefect: true,
      expectedDefectId: 'general_mapping_mappingproxy',
      oracle: probe,
    };
  }
  if (caseId === 's10-baseexception') {
    const oracle = runScenario10(workspace);
    return {
      valid: oracle.ok === false && expectedSingleFalse(oracle.checks, 'baseexception_cleanup_once'),
      expectedDefect: true,
      expectedDefectId: 'baseexception_cleanup_once',
      oracle,
    };
  }
  if (caseId === 's09-clean') {
    const oracle = runScenario09(workspace);
    return {
      valid: oracle.ok === true,
      expectedDefect: false,
      expectedDefectId: null,
      oracle,
    };
  }
  if (caseId === 's10-clean') {
    const oracle = runScenario10(workspace);
    return {
      valid: oracle.ok === true,
      expectedDefect: false,
      expectedDefectId: null,
      oracle,
    };
  }
  if (caseId === 'v2-s11-bool') {
    const oracle = validateTimeoutContract(workspace);
    return {
      valid: expectedSingleFalse(oracle.checks, 'bool_rejected'),
      expectedDefect: true,
      expectedDefectId: 'bool_is_int_contract',
      oracle,
    };
  }
  if (caseId === 'v2-s12-backslash') {
    const oracle = validateArchiveContract(workspace);
    return {
      valid: expectedSingleFalse(oracle.checks, 'backslash_separator_semantics'),
      expectedDefect: true,
      expectedDefectId: 'portable_backslash_separator',
      oracle,
    };
  }
  if (caseId === 'v2-s13-incomplete-frame') {
    const oracle = validateFrameContract(workspace);
    return {
      valid: expectedSingleFalse(oracle.checks, 'incomplete_non_destructive'),
      expectedDefect: true,
      expectedDefectId: 'incomplete_frame_mutates_buffer',
      oracle,
    };
  }
  if (caseId === 'v2-s13-clean') {
    const oracle = validateFrameContract(workspace);
    return {
      valid: Object.values(oracle.checks ?? {}).every(Boolean),
      expectedDefect: false,
      expectedDefectId: null,
      oracle,
    };
  }
  throw new Error(`Unknown reviewer-only case ${JSON.stringify(caseId)}.`);
}

function main(argv = process.argv.slice(2)) {
  const caseId = String(argv[0] ?? '').trim();
  const workspace = path.resolve(argv[1] ?? '.');
  const output = path.resolve(argv[2] ?? path.join(process.cwd(), 'reviewer-only-case-validation.json'));
  let result;
  try {
    result = { caseId, ...validateCase(caseId, workspace) };
  } catch (error) {
    result = { caseId, valid: false, error: error?.message ?? String(error) };
  }
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  expectedSingleFalse,
  runPythonProbe,
  validateMappingProxyDefect,
  validateTimeoutContract,
  validateArchiveContract,
  validateFrameContract,
  validateCase,
};
