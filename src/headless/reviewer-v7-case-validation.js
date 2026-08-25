#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateHistoricalValidationIntegrity } = require('./reviewer-v6-case-validation');
const { validateHistoricalBudget } = require('./reviewer-v5-case-validation');
const { validateHistoricalCiGate } = require('./reviewer-v6b-case-validation');

function falseKeys(checks) {
  return Object.entries(checks ?? {})
    .filter(([, value]) => value === false)
    .map(([key]) => key)
    .sort();
}

const CASES = Object.freeze({
  'v7-h15-latent-report-integrity': {
    validator: validateHistoricalValidationIntegrity,
    expected: ['successful_validation_negative_case_false_positive'],
  },
  'v7-h22-latent-turn-budget': {
    validator: validateHistoricalBudget,
    expected: ['accepted_report_order_invariance'],
  },
  'v7-h23-latent-ci-gate': {
    validator: validateHistoricalCiGate,
    expected: ['oracle_failure_propagates'],
  },
});

function validateCase(caseId, workspace) {
  const spec = CASES[caseId];
  if (!spec) throw new Error(`Unknown reviewer-v7 case ${JSON.stringify(caseId)}.`);
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
  const output = path.resolve(argv[2] ?? path.join(process.cwd(), 'reviewer-v7-case-validation.json'));
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
module.exports = { CASES, falseKeys, validateCase };
