'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runPythonProbe } = require('./reviewer-only-case-validation');

function validateWireFrameContract(workspace) {
  return runPythonProbe(workspace, String.raw`
import json
from taskflow.wireframe import MAGIC, pop_wire_frame


def make_frame(payload=b"abc", *, version=1, flags=0, checksum_delta=0):
    header = bytes((MAGIC, version, flags, len(payload)))
    checksum = ((sum(header) + sum(payload)) + checksum_delta) & 0xFF
    return bytearray(header + payload + bytes((checksum,)))


def raises_unchanged(buf):
    before = bytes(buf)
    try:
        pop_wire_frame(buf)
    except ValueError:
        return bytes(buf) == before
    except BaseException:
        return False
    return False

checks = {}

buf = make_frame(b"abc", flags=3) + bytearray(b"TAIL")
checks["baseline_valid"] = pop_wire_frame(buf) == (3, b"abc") and buf == bytearray(b"TAIL")

buf = make_frame(b"abcd")[:-2]
before = bytes(buf)
checks["baseline_incomplete"] = pop_wire_frame(buf) is None and bytes(buf) == before

buf = make_frame(b"x")
buf[0] = 0
bad_magic = raises_unchanged(buf)
future_version = raises_unchanged(make_frame(b"x", version=2))
oversize = raises_unchanged(bytearray((MAGIC, 1, 0, 33)))
checks["baseline_header_validation"] = bad_magic and future_version and oversize

checks["unsupported_version_zero"] = raises_unchanged(make_frame(b"x", version=0))
checks["reserved_flags_rejected"] = (
    raises_unchanged(make_frame(b"x", flags=0x10))
    and raises_unchanged(make_frame(b"x", flags=0x81))
)
checks["invalid_checksum_non_destructive"] = raises_unchanged(make_frame(b"abc", checksum_delta=1))

print(json.dumps({"checks": checks}))
`);
}

function falseKeys(checks) {
  return Object.entries(checks ?? {}).filter(([, value]) => value === false).map(([key]) => key).sort();
}

function validateCase(caseId, workspace) {
  const oracle = validateWireFrameContract(workspace);
  const failed = falseKeys(oracle.checks);
  if (caseId === 'v3-s14-wireframe-multidefect') {
    const expected = [
      'invalid_checksum_non_destructive',
      'reserved_flags_rejected',
      'unsupported_version_zero',
    ].sort();
    return {
      valid: JSON.stringify(failed) === JSON.stringify(expected),
      expectedDefects: expected,
      oracle,
    };
  }
  if (caseId === 'v3-s14-wireframe-clean') {
    return {
      valid: failed.length === 0,
      expectedDefects: [],
      oracle,
    };
  }
  throw new Error(`Unknown reviewer-v3 case ${JSON.stringify(caseId)}.`);
}

function main(argv = process.argv.slice(2)) {
  const caseId = String(argv[0] ?? '').trim();
  const workspace = path.resolve(argv[1] ?? '.');
  const output = path.resolve(argv[2] ?? path.join(process.cwd(), 'reviewer-v3-case-validation.json'));
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

module.exports = { validateWireFrameContract, falseKeys, validateCase };
