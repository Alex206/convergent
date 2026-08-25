#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('./runner');
const { runTopologyHeadless } = require('./topology-runner');
const { runWithStartupRetry } = require('./topology-cli');
const { runPanelReviewHeadless, REVIEW_ARMS } = require('./perspective-review-runner');

const BROAD_TERRA_ARM = 'broad-terra';
const REVIEW_BENCHMARK_ARMS = Object.freeze([
  BROAD_TERRA_ARM,
  ...Object.keys(REVIEW_ARMS),
]);

async function relabelControlResult(outputDir) {
  const resultPath = path.join(outputDir, 'result.json');
  try {
    const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    result.topology = BROAD_TERRA_ARM;
    result.topologyLabel = 'Luna implementation + broad Terra review';
    result.reviewMode = 'broad-terra';
    await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  } catch {
    // Startup failures may occur before result.json exists; the retry wrapper handles that case.
  }
}

function validateArm(value) {
  const arm = String(value ?? '').trim().toLowerCase();
  if (!REVIEW_BENCHMARK_ARMS.includes(arm)) {
    throw new Error(`Unsupported --arm ${JSON.stringify(value)}. Expected one of: ${REVIEW_BENCHMARK_ARMS.join(', ')}.`);
  }
  return arm;
}

async function runReviewBenchmark(options) {
  const arm = validateArm(options.arm);
  if (arm === BROAD_TERRA_ARM) {
    try {
      return await runTopologyHeadless({
        ...options,
        topology: 'luna-terra-structured',
      });
    } finally {
      await relabelControlResult(options.outputDir);
    }
  }
  return runPanelReviewHeadless({ ...options, arm });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.arm = validateArm(options.arm);
  await runWithStartupRetry(options, runReviewBenchmark);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  BROAD_TERRA_ARM,
  REVIEW_BENCHMARK_ARMS,
  relabelControlResult,
  validateArm,
  runReviewBenchmark,
};
