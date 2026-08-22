#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function median(values) {
  const sorted = values.map(number).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function findFiles(root, basename, found = []) {
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) findFiles(full, basename, found);
    else if (entry.isFile() && entry.name === basename) found.push(full);
  }
  return found;
}

function loadRun(resultPath) {
  const dir = path.dirname(resultPath);
  const result = readJson(resultPath, {});
  const meta = readJson(path.join(dir, 'benchmark-meta.json'), {});
  const acceptance = readJson(path.join(dir, 'scenario-acceptance.json'), {
    ok: true,
    dedicatedOracle: false,
    note: 'No scenario acceptance file was produced.',
  });
  const validation = readJson(path.join(dir, 'target-validation.json'), {
    ok: false,
    note: 'No independent target-validation result was produced.',
  });
  const topology = result.topology ?? meta.topology ?? 'unknown';
  const usage = result.usage ?? {};
  const accepted = result.status === 'complete'
    && validation.ok === true
    && acceptance.ok === true;

  return {
    dir,
    topology,
    scenario: meta.scenario ?? result.promptFile ?? 'unknown',
    repeat: number(meta.repeat) || 1,
    fixtureRef: meta.fixtureRef ?? null,
    fixtureSha: meta.fixtureSha ?? null,
    status: result.status ?? 'missing',
    accepted,
    acceptance,
    validation,
    usage: {
      aiCredits: number(usage.aiCredits),
      inputTokens: number(usage.inputTokens),
      outputTokens: number(usage.outputTokens),
      reasoningTokens: number(usage.reasoningTokens),
      cacheReadTokens: number(usage.cacheReadTokens),
      cacheWriteTokens: number(usage.cacheWriteTokens),
      calls: number(usage.calls),
      turns: number(usage.turns),
      elapsedMs: number(usage.elapsedMs),
      maxContextTokens: number(usage.maxContextTokens),
      maxContextMessages: number(usage.maxContextMessages),
    },
    error: result.error ?? null,
  };
}

function aggregateTopology(topology, runs) {
  const acceptedRuns = runs.filter((run) => run.accepted);
  const successes = acceptedRuns.length;
  const totalCredits = runs.reduce((sum, run) => sum + run.usage.aiCredits, 0);
  const totalInputTokens = runs.reduce((sum, run) => sum + run.usage.inputTokens, 0);
  const totalElapsedMs = runs.reduce((sum, run) => sum + run.usage.elapsedMs, 0);

  return {
    topology,
    runs: runs.length,
    successes,
    failures: runs.length - successes,
    acceptanceRate: runs.length ? successes / runs.length : 0,
    creditsPerSuccess: successes ? totalCredits / successes : null,
    inputTokensPerSuccess: successes ? totalInputTokens / successes : null,
    elapsedMsPerSuccess: successes ? totalElapsedMs / successes : null,
    medianAcceptedCredits: median(acceptedRuns.map((run) => run.usage.aiCredits)),
    medianAcceptedInputTokens: median(acceptedRuns.map((run) => run.usage.inputTokens)),
    medianAcceptedCalls: median(acceptedRuns.map((run) => run.usage.calls)),
    medianAcceptedElapsedMs: median(acceptedRuns.map((run) => run.usage.elapsedMs)),
    medianAcceptedMaxContextTokens: median(acceptedRuns.map((run) => run.usage.maxContextTokens)),
    totalCredits,
    totalInputTokens,
    scenariosAccepted: [...new Set(acceptedRuns.map((run) => run.scenario))].sort(),
  };
}

function finiteOrInfinity(value) {
  return value === null || !Number.isFinite(Number(value))
    ? Number.POSITIVE_INFINITY
    : Number(value);
}

function dominates(a, b) {
  const noWorse = a.acceptanceRate >= b.acceptanceRate
    && finiteOrInfinity(a.creditsPerSuccess) <= finiteOrInfinity(b.creditsPerSuccess)
    && finiteOrInfinity(a.inputTokensPerSuccess) <= finiteOrInfinity(b.inputTokensPerSuccess);
  const strictlyBetter = a.acceptanceRate > b.acceptanceRate
    || finiteOrInfinity(a.creditsPerSuccess) < finiteOrInfinity(b.creditsPerSuccess)
    || finiteOrInfinity(a.inputTokensPerSuccess) < finiteOrInfinity(b.inputTokensPerSuccess);
  return noWorse && strictlyBetter;
}

function paretoFrontier(groups) {
  return groups
    .filter((candidate) => candidate.successes > 0)
    .filter((candidate) => !groups.some(
      (other) => other.topology !== candidate.topology && dominates(other, candidate),
    ))
    .map((item) => item.topology);
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(digits);
}

function pct(value) {
  return `${fmt(number(value) * 100, 1)}%`;
}

function markdownReport(summary) {
  const frontier = new Set(summary.paretoFrontier);
  const lines = [
    '# Convergent topology tournament',
    '',
    `Runs: **${summary.runs.length}** · accepted: **${summary.runs.filter((run) => run.accepted).length}**`,
    '',
    '| Topology | Accept | Credits / success | Input tokens / success | Median calls | Median time | Peak context | Pareto |',
    '|---|---:|---:|---:|---:|---:|---:|:---:|',
  ];

  for (const item of summary.topologies) {
    lines.push(
      `| ${item.topology} | ${item.successes}/${item.runs} (${pct(item.acceptanceRate)}) | `
      + `${fmt(item.creditsPerSuccess, 3)} | ${fmt(item.inputTokensPerSuccess, 0)} | `
      + `${fmt(item.medianAcceptedCalls, 1)} | ${fmt(item.medianAcceptedElapsedMs / 1000, 1)}s | `
      + `${fmt(item.medianAcceptedMaxContextTokens, 0)} | ${frontier.has(item.topology) ? '✓' : ''} |`,
    );
  }

  lines.push(
    '',
    'Acceptance is a gate: a run counts only when the topology runner completes, independent target tests pass, and the registered deterministic scenario oracle passes.',
    'Cost-per-success includes inference spent on failed runs, so cheap-but-unreliable topologies are penalized rather than rewarded.',
    '',
    `Pareto frontier (acceptance ↑, credits/success ↓, input-tokens/success ↓): **${summary.paretoFrontier.join(', ') || 'none'}**`,
    '',
    '## Failed runs',
    '',
  );

  const failed = summary.runs.filter((run) => !run.accepted);
  if (!failed.length) lines.push('None.');
  else {
    for (const run of failed) {
      lines.push(`- **${run.topology}** · ${run.scenario} · repeat ${run.repeat}: ${run.status}${run.error ? ` — ${run.error}` : ''}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function buildTournamentReport(root) {
  const runs = findFiles(root, 'result.json').map(loadRun);
  const byTopology = new Map();
  for (const run of runs) {
    const list = byTopology.get(run.topology) ?? [];
    list.push(run);
    byTopology.set(run.topology, list);
  }
  const topologies = [...byTopology.entries()]
    .map(([topology, items]) => aggregateTopology(topology, items))
    .sort((a, b) => (
      b.acceptanceRate - a.acceptanceRate
      || finiteOrInfinity(a.creditsPerSuccess) - finiteOrInfinity(b.creditsPerSuccess)
      || finiteOrInfinity(a.inputTokensPerSuccess) - finiteOrInfinity(b.inputTokensPerSuccess)
    ));
  return {
    generatedAt: new Date().toISOString(),
    root: path.resolve(root),
    runs,
    topologies,
    paretoFrontier: paretoFrontier(topologies),
  };
}

function main(argv = process.argv.slice(2)) {
  const root = path.resolve(argv[0] ?? '.');
  const jsonOut = path.resolve(argv[1] ?? path.join(root, 'topology-report.json'));
  const markdownOut = path.resolve(argv[2] ?? path.join(root, 'topology-report.md'));
  const summary = buildTournamentReport(root);
  fs.writeFileSync(jsonOut, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownOut, `${markdownReport(summary)}\n`, 'utf8');
  process.stdout.write(`${markdownReport(summary)}\n`);
}

if (require.main === module) main();

module.exports = {
  median,
  loadRun,
  aggregateTopology,
  dominates,
  paretoFrontier,
  markdownReport,
  buildTournamentReport,
};
