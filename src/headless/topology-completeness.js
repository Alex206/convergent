'use strict';

const fs = require('node:fs');
const path = require('node:path');

function normalizeExpectation(entry) {
  if (typeof entry === 'string') {
    const match = /^(.+?)=(\d+)$/.exec(entry.trim());
    if (!match) throw new Error(`Invalid topology expectation ${JSON.stringify(entry)}; expected <topology>=<runs>.`);
    entry = { topology: match[1], runs: Number(match[2]) };
  }
  const topology = String(entry?.topology ?? '').trim();
  const runs = Number(entry?.runs);
  if (!topology) throw new Error('Topology expectation requires topology.');
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`Topology expectation ${topology} requires a positive integer run count.`);
  }
  return { topology, runs };
}

function evaluateTopologyCompleteness(report = {}, expectations = []) {
  const expected = expectations.map(normalizeExpectation);
  if (!expected.length) throw new Error('At least one topology expectation is required.');
  if (new Set(expected.map((entry) => entry.topology)).size !== expected.length) {
    throw new Error('Topology expectations must use unique topology names.');
  }

  const actualRuns = new Map();
  for (const run of Array.isArray(report?.runs) ? report.runs : []) {
    const topology = String(run?.topology ?? '').trim();
    if (!topology) continue;
    actualRuns.set(topology, (actualRuns.get(topology) ?? 0) + 1);
  }

  const arms = expected.map((entry) => ({
    topology: entry.topology,
    expectedRuns: entry.runs,
    actualRuns: actualRuns.get(entry.topology) ?? 0,
  }));
  const missing = arms.filter((entry) => entry.actualRuns < entry.expectedRuns);
  return {
    ok: missing.length === 0,
    arms,
    missing,
    scoredRuns: Array.isArray(report?.runs) ? report.runs.length : 0,
  };
}

function renderTopologyCompleteness(result) {
  const lines = [
    '# Topology comparison completeness',
    '',
    result.ok
      ? 'All expected topology samples are present and scored.'
      : 'The comparison is **incomplete**. Infrastructure-invalid or missing samples must be rerun before interpreting the head-to-head.',
    '',
    '| Topology | Expected valid runs | Actual valid runs | Complete |',
    '|---|---:|---:|:---:|',
  ];
  for (const arm of result.arms) {
    lines.push(`| ${arm.topology} | ${arm.expectedRuns} | ${arm.actualRuns} | ${arm.actualRuns >= arm.expectedRuns ? '✓' : '✗'} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  const [reportPath, outputJson, outputMarkdown, ...rawExpectations] = argv;
  if (!reportPath || !outputJson || !outputMarkdown || !rawExpectations.length) {
    throw new Error('Usage: topology-completeness <report.json> <output.json> <output.md> <topology>=<runs> [...]');
  }
  const report = JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8'));
  const result = evaluateTopologyCompleteness(report, rawExpectations);
  fs.writeFileSync(path.resolve(outputJson), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.resolve(outputMarkdown), renderTopologyCompleteness(result), 'utf8');
  if (!result.ok) process.exitCode = 2;
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  normalizeExpectation,
  evaluateTopologyCompleteness,
  renderTopologyCompleteness,
  main,
};
