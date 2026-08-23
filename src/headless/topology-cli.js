#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('./runner');
const { runTopologyHeadless } = require('./topology-runner');

async function readResult(outputDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(outputDir, 'result.json'), 'utf8'));
  } catch {
    return null;
  }
}

function isRetryableStartupStall(result, error) {
  if (!result || result.status !== 'failed') return false;
  if (Number(result?.usage?.calls ?? 0) !== 0) return false;
  const text = `${result.error ?? ''}\n${error?.message ?? error ?? ''}`;
  return /produced no agent\/tool activity/i.test(text);
}

async function preserveStartupStall(outputDir, result) {
  const recordPath = path.join(outputDir, 'startup-retries.json');
  let records = [];
  try {
    records = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    if (!Array.isArray(records)) records = [];
  } catch {}
  records.push({
    at: new Date().toISOString(),
    reason: result.error ?? 'zero-call startup stall',
    status: result.status,
    calls: Number(result?.usage?.calls ?? 0),
    inputTokens: Number(result?.usage?.inputTokens ?? 0),
    aiCredits: Number(result?.usage?.aiCredits ?? 0),
  });
  await fs.writeFile(recordPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await fs.rename(
    path.join(outputDir, 'result.json'),
    path.join(outputDir, `startup-stall-attempt-${records.length}-result.json`),
  ).catch(() => {});
}

async function runWithStartupRetry(options, runner = runTopologyHeadless) {
  try {
    return await runner(options);
  } catch (error) {
    const result = await readResult(options.outputDir);
    if (!isRetryableStartupStall(result, error)) throw error;

    await preserveStartupStall(options.outputDir, result);
    console.error(
      'Benchmark session stalled before its first model/tool activity; retrying the same fresh-workspace topology sample once.',
    );
    return runner(options);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await runWithStartupRetry(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  readResult,
  isRetryableStartupStall,
  preserveStartupStall,
  runWithStartupRetry,
};
