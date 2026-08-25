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

function validateMappingProxyDefect(workspace) {
  const script = String.raw`
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
`;
  const stdout = execFileSync(pythonExecutable(), ['-B', '-c', script], {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
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

module.exports = { expectedSingleFalse, validateMappingProxyDefect, validateCase };
