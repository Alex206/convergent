#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function stepBlock(source, stepName) {
  const lines = String(source ?? '').split(/\r?\n/);
  const marker = `- name: ${stepName}`;
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start < 0) return '';
  const indent = lines[start].match(/^\s*/)?.[0].length ?? 0;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const currentIndent = line.match(/^\s*/)?.[0].length ?? 0;
    if (currentIndent === indent && line.trim().startsWith('- name: ')) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function falseKeys(checks) {
  return Object.entries(checks ?? {})
    .filter(([, value]) => value === false)
    .map(([key]) => key)
    .sort();
}

function validateHistoricalCiGate(workspace) {
  const file = path.join(workspace, '.github', 'workflows', 'ci.yml');
  const source = fs.readFileSync(file, 'utf8');
  const validation = stepBlock(source, 'Independently validate benchmark target');
  const upload = stepBlock(source, 'Upload headless benchmark evidence');
  if (!validation) throw new Error('Independent benchmark validation step is missing.');
  if (!upload) throw new Error('Benchmark evidence upload step is missing.');

  return {
    checks: {
      oracle_failure_propagates: !/\bcontinue-on-error\s*:\s*true\b/i.test(validation),
      validation_runs_after_prior_failure: /\bif\s*:\s*always\(\)/i.test(validation),
      shell_pipeline_preserves_failure: /\bset\s+-o\s+pipefail\b/.test(validation),
      deterministic_oracle_is_executed: /scenario03-acceptance\.js/.test(validation),
      target_tests_are_executed: /unittest\s+discover/.test(validation),
      evidence_upload_survives_failure: /\bif\s*:\s*always\(\)/i.test(upload),
      evidence_upload_uses_artifact_action: /actions\/upload-artifact@v\d+/i.test(upload),
    },
  };
}

const CASES = Object.freeze({
  'v6b-h23-ci-oracle-gate-regression': {
    validator: validateHistoricalCiGate,
    expected: ['oracle_failure_propagates'],
  },
  'v6b-h23-ci-oracle-gate-fixed': {
    validator: validateHistoricalCiGate,
    expected: [],
  },
});

function validateCase(caseId, workspace) {
  const spec = CASES[caseId];
  if (!spec) throw new Error(`Unknown reviewer-v6b case ${JSON.stringify(caseId)}.`);
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
  const output = path.resolve(argv[2] ?? path.join(process.cwd(), 'reviewer-v6b-case-validation.json'));
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

module.exports = { CASES, stepBlock, falseKeys, validateHistoricalCiGate, validateCase };
