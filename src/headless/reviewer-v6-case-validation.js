#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runNode(workspace, source) {
  const result = spawnSync('node', ['-e', source], { cwd: workspace, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`node probe failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim());
}

function falseKeys(checks) {
  return Object.entries(checks ?? {})
    .filter(([, value]) => value === false)
    .map(([key]) => key)
    .sort();
}

function validateHistoricalValidationIntegrity(workspace) {
  const modulePath = JSON.stringify(path.join(workspace, 'src', 'orchestrator', 'report-blocker.js'));
  return runNode(workspace, String.raw`
const {
  validationBlockerEvidence,
  reconcileExplicitValidationBlocker,
} = require(${modulePath});

const checks = {};

const benignNegativeCase = 'The required external validator passes with the scoped credential; TASKFLOW_RELEASE_TOKEN missing behavior is covered by tests and raises RuntimeError as required.';
const reconciledBenign = reconcileExplicitValidationBlocker({
  verdict: 'clean',
  summary: benignNegativeCase,
  findings: [],
  checks: [],
});
checks.successful_validation_negative_case_false_positive = (
  validationBlockerEvidence(benignNegativeCase) === false
  && reconciledBenign.report.verdict === 'clean'
);

const genuineMissing = 'A unit validator passed, but the required external validator failed because TASKFLOW_RELEASE_TOKEN is not configured.';
checks.genuine_unresolved_prerequisite_stays_blocking = (
  validationBlockerEvidence(genuineMissing) === true
  && reconcileExplicitValidationBlocker({ verdict: 'clean', summary: genuineMissing, findings: [], checks: [] }).report.verdict === 'blocked'
);

const explicit = 'BLOCKED: required external validator is unavailable until TASKFLOW_RELEASE_TOKEN is configured.';
checks.explicit_blocked_stays_blocking = validationBlockerEvidence(explicit) === true;

const ordinary = 'Unit tests cover malformed input and expected exceptions. Required validation passed successfully.';
checks.ordinary_success_not_blocking = validationBlockerEvidence(ordinary) === false;

console.log(JSON.stringify({ checks }));
`);
}

const CASES = Object.freeze({
  'v6-h15-validation-language-regression': {
    validator: validateHistoricalValidationIntegrity,
    expected: ['successful_validation_negative_case_false_positive'],
  },
  'v6-h15-validation-language-fixed': {
    validator: validateHistoricalValidationIntegrity,
    expected: [],
  },
});

function validateCase(caseId, workspace) {
  const spec = CASES[caseId];
  if (!spec) throw new Error(`Unknown reviewer-v6 case ${JSON.stringify(caseId)}.`);
  const oracle = spec.validator(workspace);
  const failed = falseKeys(oracle.checks);
  const expected = [...spec.expected].sort();
  return {
    valid: JSON.stringify(failed) === JSON.stringify(expected),
    expectedDefects: expected,
    oracle,
  };
}

function main(argv = process.argv.slice(2)) {
  const caseId = String(argv[0] ?? '').trim();
  const workspace = path.resolve(argv[1] ?? '.');
  const output = path.resolve(argv[2] ?? path.join(process.cwd(), 'reviewer-v6-case-validation.json'));
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

module.exports = { CASES, falseKeys, validateHistoricalValidationIntegrity, validateCase };
