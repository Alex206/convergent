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

function readJsonLines(file) {
  if (!file || !fs.existsSync(file)) return [];
  const events = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Keep reporting fail-open when an audit contains a partial/truncated line.
    }
  }
  return events;
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

function auditEvidence(dir) {
  const auditRoot = path.join(dir, 'audit');
  const summaryPath = findFiles(auditRoot, 'summary.json')[0] ?? null;
  const eventsPath = findFiles(auditRoot, 'events.jsonl')[0] ?? null;
  return {
    summary: summaryPath ? readJson(summaryPath, {}) : {},
    events: readJsonLines(eventsPath),
  };
}

function eventFindings(event) {
  const findings = event?.findings ?? event?.review?.findings ?? event?.report?.findings;
  return Array.isArray(findings) ? findings : [];
}

function reviewSignal(audit) {
  const events = audit.events ?? [];
  const workerEvents = events.filter((event) => event.type === 'worker_pass_result');
  const peerCriticEvents = events.filter((event) => event.type === 'benchmark_peer_critic_result');
  const strongReviewEvents = events.filter((event) => event.type === 'strong_review_result');
  const workerAEvents = workerEvents.filter((event) => event.worker === 'A');
  const workerBEvents = workerEvents.filter((event) => event.worker === 'B');
  const sumFindings = (items) => items.reduce((sum, item) => sum + eventFindings(item).length, 0);

  return {
    peerCriticCycles: peerCriticEvents.length,
    peerCriticFindings: sumFindings(peerCriticEvents),
    workerBPasses: workerBEvents.length,
    workerBChangedPasses: workerBEvents.filter((event) => event.changed === true).length,
    workerBFindings: sumFindings(workerBEvents),
    strongReviewCycles: strongReviewEvents.length,
    strongReviewFindings: sumFindings(strongReviewEvents),
    remediationPasses: Math.max(0, workerAEvents.length - 1),
    repeatedToolSignatureCount: number(audit.summary?.trajectory?.repeatedToolSignatureCount),
  };
}

function rolePriority(label) {
  const order = ['Terra solo', 'Worker A', 'Peer critic', 'Worker B', 'Strong reviewer'];
  const index = order.indexOf(label);
  return index < 0 ? order.length : index;
}

function agentDetails(usage, audit) {
  const trajectoryAgents = audit.summary?.trajectory?.agents ?? {};
  const usageAgents = Array.isArray(usage.agents) ? usage.agents : [];
  const usageByLabel = new Map(usageAgents.map((agent) => [agent.label ?? agent.agent, agent]));
  const labels = new Set([...Object.keys(trajectoryAgents), ...usageByLabel.keys()]);

  return [...labels]
    .map((label) => {
      const usageAgent = usageByLabel.get(label) ?? {};
      const trajectory = trajectoryAgents[label] ?? {};
      return {
        label,
        model: usageAgent.model ?? trajectory.model ?? null,
        modelId: usageAgent.modelId ?? null,
        reasoningEffort: trajectory.reasoningEffort ?? null,
        calls: number(usageAgent.calls ?? trajectory.llmCalls),
        turns: number(usageAgent.turns),
        inputTokens: number(usageAgent.inputTokens ?? trajectory.inputTokens),
        outputTokens: number(usageAgent.outputTokens ?? trajectory.outputTokens),
        reasoningTokens: number(usageAgent.reasoningTokens ?? trajectory.reasoningTokens),
        cacheReadTokens: number(usageAgent.cacheReadTokens ?? trajectory.cacheReadTokens),
        cacheWriteTokens: number(usageAgent.cacheWriteTokens ?? trajectory.cacheWriteTokens),
        aiCredits: number(usageAgent.aiCredits),
        durationMs: number(usageAgent.durationMs),
        maxContextTokens: number(usageAgent.maxContextTokens ?? trajectory.peakContextTokens),
        maxContextMessages: number(usageAgent.maxContextMessages ?? trajectory.peakContextMessages),
        systemPromptChars: number(trajectory.systemPromptChars),
        promptChars: number(trajectory.promptChars),
        promptSends: number(trajectory.promptSends),
        toolCalls: number(trajectory.toolCalls),
        tools: trajectory.tools ?? {},
      };
    })
    .sort((a, b) => rolePriority(a.label) - rolePriority(b.label) || a.label.localeCompare(b.label));
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
  const audit = auditEvidence(dir);

  const normalizedUsage = {
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
  };

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
    usage: normalizedUsage,
    agents: agentDetails(usage, audit),
    reviewSignal: reviewSignal(audit),
    error: result.error ?? null,
  };
}

function aggregateAgentRoles(runs) {
  const byRole = new Map();
  for (const run of runs) {
    for (const agent of run.agents ?? []) {
      const list = byRole.get(agent.label) ?? [];
      list.push(agent);
      byRole.set(agent.label, list);
    }
  }

  return [...byRole.entries()]
    .map(([label, agents]) => ({
      label,
      model: agents.find((agent) => agent.model)?.model ?? null,
      runs: agents.length,
      totalCredits: agents.reduce((sum, agent) => sum + agent.aiCredits, 0),
      totalInputTokens: agents.reduce((sum, agent) => sum + agent.inputTokens, 0),
      medianCredits: median(agents.map((agent) => agent.aiCredits)),
      medianInputTokens: median(agents.map((agent) => agent.inputTokens)),
      medianCalls: median(agents.map((agent) => agent.calls)),
      medianToolCalls: median(agents.map((agent) => agent.toolCalls)),
      medianDurationMs: median(agents.map((agent) => agent.durationMs)),
      medianSystemPromptChars: median(agents.map((agent) => agent.systemPromptChars)),
      medianPromptChars: median(agents.map((agent) => agent.promptChars)),
      medianMaxContextTokens: median(agents.map((agent) => agent.maxContextTokens)),
    }))
    .sort((a, b) => rolePriority(a.label) - rolePriority(b.label) || a.label.localeCompare(b.label));
}

function aggregateReviewSignal(runs) {
  const sum = (key) => runs.reduce((total, run) => total + number(run.reviewSignal?.[key]), 0);
  return {
    peerCriticCycles: sum('peerCriticCycles'),
    peerCriticFindings: sum('peerCriticFindings'),
    workerBPasses: sum('workerBPasses'),
    workerBChangedPasses: sum('workerBChangedPasses'),
    workerBFindings: sum('workerBFindings'),
    strongReviewCycles: sum('strongReviewCycles'),
    strongReviewFindings: sum('strongReviewFindings'),
    remediationPasses: sum('remediationPasses'),
    repeatedToolSignatureCount: sum('repeatedToolSignatureCount'),
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
    medianAcceptedToolCalls: median(acceptedRuns.map(
      (run) => (run.agents ?? []).reduce((sum, agent) => sum + agent.toolCalls, 0),
    )),
    totalCredits,
    totalInputTokens,
    scenariosAccepted: [...new Set(acceptedRuns.map((run) => run.scenario))].sort(),
    agentRoles: aggregateAgentRoles(runs),
    reviewSignal: aggregateReviewSignal(runs),
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
    '| Topology | Accept | Credits / success | Input tokens / success | Median calls | Median tools | Median time | Peak context | Pareto |',
    '|---|---:|---:|---:|---:|---:|---:|---:|:---:|',
  ];

  for (const item of summary.topologies) {
    lines.push(
      `| ${item.topology} | ${item.successes}/${item.runs} (${pct(item.acceptanceRate)}) | `
      + `${fmt(item.creditsPerSuccess, 3)} | ${fmt(item.inputTokensPerSuccess, 0)} | `
      + `${fmt(item.medianAcceptedCalls, 1)} | ${fmt(item.medianAcceptedToolCalls, 1)} | `
      + `${fmt(item.medianAcceptedElapsedMs / 1000, 1)}s | `
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
    '## Review / peer signal',
    '',
    '| Topology | Peer critic findings | Worker B findings | Worker B changed passes | Strong-review findings | A remediation passes | Repeated tool signatures |',
    '|---|---:|---:|---:|---:|---:|---:|',
  );

  for (const item of summary.topologies) {
    const signal = item.reviewSignal;
    lines.push(
      `| ${item.topology} | ${signal.peerCriticFindings} | ${signal.workerBFindings} | `
      + `${signal.workerBChangedPasses} | ${signal.strongReviewFindings} | `
      + `${signal.remediationPasses} | ${signal.repeatedToolSignatureCount} |`,
    );
  }

  lines.push('', '## Agent cost / context breakdown', '');
  lines.push('| Topology | Role | Model | Credits | Input tokens | Calls | Tools | Time | System prompt chars | Prompt chars | Peak context |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const item of summary.topologies) {
    for (const role of item.agentRoles) {
      lines.push(
        `| ${item.topology} | ${role.label} | ${role.model ?? '—'} | ${fmt(role.medianCredits, 3)} | `
        + `${fmt(role.medianInputTokens, 0)} | ${fmt(role.medianCalls, 1)} | ${fmt(role.medianToolCalls, 1)} | `
        + `${fmt(role.medianDurationMs / 1000, 1)}s | ${fmt(role.medianSystemPromptChars, 0)} | `
        + `${fmt(role.medianPromptChars, 0)} | ${fmt(role.medianMaxContextTokens, 0)} |`,
      );
    }
  }

  lines.push('', '## Per-run signal', '');
  lines.push('| Topology | Scenario | Repeat | Accept | Credits | Input tokens | Calls | Peer signal | Strong findings | Remediation |');
  lines.push('|---|---|---:|:---:|---:|---:|---:|---:|---:|---:|');
  for (const run of summary.runs) {
    const signal = run.reviewSignal;
    const peerSignal = signal.peerCriticFindings + signal.workerBFindings + signal.workerBChangedPasses;
    lines.push(
      `| ${run.topology} | ${run.scenario} | ${run.repeat} | ${run.accepted ? '✓' : '✗'} | `
      + `${fmt(run.usage.aiCredits, 3)} | ${fmt(run.usage.inputTokens, 0)} | ${fmt(run.usage.calls, 0)} | `
      + `${peerSignal} | ${signal.strongReviewFindings} | ${signal.remediationPasses} |`,
    );
  }

  lines.push('', '## Failed runs', '');
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
  aggregateAgentRoles,
  aggregateReviewSignal,
  aggregateTopology,
  dominates,
  paretoFrontier,
  markdownReport,
  buildTournamentReport,
};
