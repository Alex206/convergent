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

function runRepeat(run, topology) {
  const repeat = Number(run?.repeat);
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error(`Scored topology run ${topology} requires a positive integer repeat id.`);
  }
  return repeat;
}

function evaluateTopologyCompleteness(report = {}, expectations = []) {
  const expected = expectations.map(normalizeExpectation);
  if (!expected.length) throw new Error('At least one topology expectation is required.');
  if (new Set(expected.map((entry) => entry.topology)).size !== expected.length) {
    throw new Error('Topology expectations must use unique topology names.');
  }

  const repeatsByTopology = new Map();
  const duplicates = [];
  for (const run of Array.isArray(report?.runs) ? report.runs : []) {
    const topology = String(run?.topology ?? '').trim();
    if (!topology) continue;
    const repeat = runRepeat(run, topology);
    const repeats = repeatsByTopology.get(topology) ?? new Set();
    if (repeats.has(repeat)) duplicates.push({ topology, repeat });
    repeats.add(repeat);
    repeatsByTopology.set(topology, repeats);
  }

  const arms = expected.map((entry) => {
    const repeats = [...(repeatsByTopology.get(entry.topology) ?? new Set())].sort((a, b) => a - b);
    return {
      topology: entry.topology,
      expectedRuns: entry.runs,
      actualRuns: repeats.length,
      repeats,
    };
  });
  const missing = arms.filter((entry) => entry.actualRuns < entry.expectedRuns);
  return {
    ok: missing.length === 0 && duplicates.length === 0,
    arms,
    missing,
    duplicateRepeats: duplicates,
    scoredRuns: Array.isArray(report?.runs) ? report.runs.length : 0,
  };
}

function renderTopologyCompleteness(result) {
  const lines = [
    '# Topology comparison completeness',
    '',
    result.ok
      ? 'All expected topology samples are present as distinct scored repeats.'
      : 'The comparison is **incomplete**. Infrastructure-invalid, missing, or duplicate samples must be resolved before interpreting the head-to-head.',
    '',
    '| Topology | Expected valid repeats | Actual distinct repeats | Repeat IDs | Complete |',
    '|---|---:|---:|---|:---:|',
  ];
  for (const arm of result.arms) {
    const complete = arm.actualRuns >= arm.expectedRuns;
    lines.push(`| ${arm.topology} | ${arm.expectedRuns} | ${arm.actualRuns} | ${arm.repeats.join(', ') || '—'} | ${complete ? '✓' : '✗'} |`);
  }
  if (result.duplicateRepeats?.length) {
    lines.push('', `Duplicate scored repeat(s): ${result.duplicateRepeats.map((entry) => `${entry.topology}#${entry.repeat}`).join(', ')}`);
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
  runRepeat,
  evaluateTopologyCompleteness,
  renderTopologyCompleteness,
  main,
};
