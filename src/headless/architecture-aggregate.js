#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

function inferredRecoveryPolicy(run = {}) {
  if (run.recoveryPolicy) return run.recoveryPolicy;
  return run.architecture === 'convergent-v02' ? 'strong-coordinator' : 'none';
}

function variantKey(run) {
  return `${run.architecture}|recovery=${inferredRecoveryPolicy(run)}|${JSON.stringify(stableObject(run.selectors ?? {}))}`;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const ordered = values.map(Number).sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!total) return { low: 0, high: 1 };
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p) / total) + (z2 / (4 * total * total)));
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

function numeric(run, field) {
  const value = Number(run?.[field]);
  return Number.isFinite(value) ? value : 0;
}

function optionalNumeric(run, field) {
  if (run?.[field] === null || run?.[field] === undefined) return null;
  const value = Number(run[field]);
  return Number.isFinite(value) ? value : null;
}

function aggregateRuns(runs = []) {
  const groups = new Map();
  for (const run of runs) {
    const key = variantKey(run);
    const group = groups.get(key) ?? {
      key,
      architecture: run.architecture,
      recoveryPolicy: inferredRecoveryPolicy(run),
      selectors: stableObject(run.selectors ?? {}),
      runs: [],
    };
    group.runs.push(run);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const items = group.runs;
    const successful = items.filter((run) => run.oraclePass === true);
    const passes = successful.length;
    const n = items.length;
    const interval = wilsonInterval(passes, n);
    const fields = [
      'modelCalls', 'elapsedMs', 'inputTokens', 'outputTokens',
      'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'maxContextTokens',
      'promptSends', 'toolCalls', 'turns', 'premiumRequestCost', 'reviewerCycles', 'reviewerFindings',
      'workerPasses', 'convergenceEvents', 'recoveryReports',
    ];
    const averages = {};
    const medians = {};
    for (const field of fields) {
      const values = items.map((run) => numeric(run, field));
      averages[field] = mean(values);
      medians[field] = median(values);
    }
    const creditValues = items.map((run) => optionalNumeric(run, 'aiCredits')).filter((value) => value !== null);
    averages.aiCredits = mean(creditValues);
    medians.aiCredits = median(creditValues);

    const creditDataComplete = creditValues.length === n;
    const totalKnownCredits = creditValues.reduce((sum, value) => sum + value, 0);
    const totalCalls = items.reduce((sum, run) => sum + numeric(run, 'modelCalls'), 0);
    const totalInputTokens = items.reduce((sum, run) => sum + numeric(run, 'inputTokens'), 0);
    const totalElapsedMs = items.reduce((sum, run) => sum + numeric(run, 'elapsedMs'), 0);
    return {
      key: group.key,
      architecture: group.architecture,
      recoveryPolicy: group.recoveryPolicy,
      selectors: group.selectors,
      n,
      passes,
      failures: n - passes,
      passRate: n ? passes / n : 0,
      passRateWilson95: interval,
      creditDataComplete,
      creditSamples: creditValues.length,
      averages,
      medians,
      observedCostPerSuccess: passes ? {
        aiCredits: creditDataComplete ? totalKnownCredits / passes : null,
        modelCalls: totalCalls / passes,
        inputTokens: totalInputTokens / passes,
        elapsedMs: totalElapsedMs / passes,
      } : null,
      sourceRepetitions: items.map((run) => run.repetition).filter((value) => value !== undefined),
    };
  }).sort((a, b) => {
    if (a.passRate !== b.passRate) return b.passRate - a.passRate;
    const aCredits = a.observedCostPerSuccess?.aiCredits;
    const bCredits = b.observedCostPerSuccess?.aiCredits;
    if (aCredits === null || aCredits === undefined) return 1;
    if (bCredits === null || bCredits === undefined) return -1;
    return aCredits - bCredits;
  });
}

function loadResultFiles(files) {
  const runs = [];
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const repetition = parsed.repetition;
    for (const run of parsed.runs ?? []) runs.push({ ...run, repetition, sourceFile: file });
  }
  return runs;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length < 2) {
    console.error('Usage: node src/headless/architecture-aggregate.js <output.json> <result-file> [result-file...]');
    return 2;
  }
  const [outputFile, ...resultFiles] = argv;
  const runs = loadResultFiles(resultFiles);
  const groups = aggregateRuns(runs);
  const output = {
    generatedAt: new Date().toISOString(),
    totalRuns: runs.length,
    groups,
    warning: 'Small-n stochastic benchmark statistics are descriptive. Wilson intervals show uncertainty; recovery policy is a separate experiment dimension and missing accumulated AI-credit data is never treated as zero cost.',
  };
  fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
  fs.writeFileSync(path.resolve(outputFile), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  stableObject,
  inferredRecoveryPolicy,
  variantKey,
  mean,
  median,
  wilsonInterval,
  numeric,
  optionalNumeric,
  aggregateRuns,
  loadResultFiles,
  main,
};
