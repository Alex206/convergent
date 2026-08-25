#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
      // Audit reporting remains fail-open for a partial/truncated final line.
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

function eventFindings(event) {
  const findings = event?.findings ?? event?.review?.findings ?? event?.report?.findings;
  return Array.isArray(findings) ? findings : [];
}

function panelSignal(events) {
  const plans = events.filter((event) => event.type === 'benchmark_review_protocol_plan');
  const reviewerEvents = events.filter((event) => event.type === 'benchmark_panel_review_result');
  const adjudicationEvents = events.filter((event) => event.type === 'benchmark_panel_adjudication');
  const initialReviewerEvents = reviewerEvents.filter((event) => number(event.cycle) === 1);
  const initialHits = initialReviewerEvents.filter((event) => eventFindings(event).length > 0);
  const sumFindings = (items) => items.reduce((sum, item) => sum + eventFindings(item).length, 0);

  return {
    reviewMode: reviewerEvents.find((event) => event.reviewMode)?.reviewMode
      ?? adjudicationEvents.find((event) => event.reviewMode)?.reviewMode
      ?? plans.find((event) => event.reviewMode)?.reviewMode
      ?? null,
    plannedProtocols: plans.flatMap((event) => (Array.isArray(event.selected) ? event.selected : [])),
    initialReviewerPasses: initialReviewerEvents.length,
    initialReviewerHits: initialHits.length,
    initialPanelDetected: initialHits.length > 0,
    initialFindings: sumFindings(initialReviewerEvents),
    totalReviewerPasses: reviewerEvents.length,
    totalFindings: sumFindings(reviewerEvents),
    adjudicationCycles: adjudicationEvents.length,
    adjudicatedFindings: sumFindings(adjudicationEvents),
    initialReviewers: initialReviewerEvents.map((event) => ({
      reviewerId: event.reviewerId ?? event.label ?? 'unknown',
      label: event.label ?? event.reviewerId ?? 'unknown',
      verdict: event.verdict ?? null,
      findings: eventFindings(event).length,
    })),
  };
}

function loadRun(resultPath) {
  const dir = path.dirname(resultPath);
  const meta = readJson(path.join(dir, 'benchmark-meta.json'), {});
  const result = readJson(resultPath, {});
  const eventsPath = findFiles(path.join(dir, 'audit'), 'events.jsonl')[0] ?? null;
  const signal = panelSignal(readJsonLines(eventsPath));
  return {
    dir,
    topology: result.topology ?? meta.topology ?? 'unknown',
    scenario: meta.scenario ?? result.promptFile ?? 'unknown',
    repeat: number(meta.repeat) || 1,
    status: result.status ?? 'missing',
    signal,
  };
}

function aggregateReviewerSignal(runs) {
  const byReviewer = new Map();
  for (const run of runs) {
    for (const reviewer of run.signal.initialReviewers) {
      const key = reviewer.reviewerId;
      const current = byReviewer.get(key) ?? {
        reviewerId: key,
        label: reviewer.label,
        initialPasses: 0,
        initialHits: 0,
        initialFindings: 0,
      };
      current.initialPasses += 1;
      if (reviewer.findings > 0) current.initialHits += 1;
      current.initialFindings += reviewer.findings;
      byReviewer.set(key, current);
    }
  }
  return [...byReviewer.values()].sort((a, b) => a.reviewerId.localeCompare(b.reviewerId));
}

function aggregateProtocolSelections(runs) {
  const counts = new Map();
  for (const run of runs) {
    for (const protocol of run.signal.plannedProtocols) {
      counts.set(protocol, (counts.get(protocol) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([protocol, selections]) => ({ protocol, selections }))
    .sort((a, b) => b.selections - a.selections || a.protocol.localeCompare(b.protocol));
}

function aggregateArm(topology, runs) {
  const panelRuns = runs.filter((run) => run.signal.initialReviewerPasses > 0);
  const detectedRuns = panelRuns.filter((run) => run.signal.initialPanelDetected);
  const initialReviewerPasses = runs.reduce((sum, run) => sum + run.signal.initialReviewerPasses, 0);
  const initialReviewerHits = runs.reduce((sum, run) => sum + run.signal.initialReviewerHits, 0);
  return {
    topology,
    runs: runs.length,
    panelRuns: panelRuns.length,
    detectedRuns: detectedRuns.length,
    initialDetectionRate: panelRuns.length ? detectedRuns.length / panelRuns.length : null,
    initialReviewerPasses,
    initialReviewerHits,
    initialReviewerHitRate: initialReviewerPasses ? initialReviewerHits / initialReviewerPasses : null,
    initialFindings: runs.reduce((sum, run) => sum + run.signal.initialFindings, 0),
    totalReviewerPasses: runs.reduce((sum, run) => sum + run.signal.totalReviewerPasses, 0),
    totalFindings: runs.reduce((sum, run) => sum + run.signal.totalFindings, 0),
    adjudicationCycles: runs.reduce((sum, run) => sum + run.signal.adjudicationCycles, 0),
    adjudicatedFindings: runs.reduce((sum, run) => sum + run.signal.adjudicatedFindings, 0),
    reviewers: aggregateReviewerSignal(runs),
    protocolSelections: aggregateProtocolSelections(runs),
  };
}

function buildPerspectiveReviewReport(root) {
  const runs = findFiles(root, 'result.json').map(loadRun);
  const byTopology = new Map();
  for (const run of runs) {
    const list = byTopology.get(run.topology) ?? [];
    list.push(run);
    byTopology.set(run.topology, list);
  }
  const arms = [...byTopology.entries()]
    .map(([topology, items]) => aggregateArm(topology, items))
    .sort((a, b) => a.topology.localeCompare(b.topology));
  return {
    generatedAt: new Date().toISOString(),
    root: path.resolve(root),
    runs,
    arms,
  };
}

function pct(value) {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function markdownReport(report) {
  const lines = [
    '# Perspective review discovery report',
    '',
    'Initial discovery is measured only from Luna panel cycle 1. Later remediation cycles are reported separately and do not inflate the initial-detection signal.',
    '',
    '## Panel discovery by arm',
    '',
    '| Arm | Panel runs | Initial detection | Reviewer hits | Initial findings | All panel findings | Terra adjudicated findings |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];

  for (const arm of report.arms) {
    const detection = arm.panelRuns ? `${arm.detectedRuns}/${arm.panelRuns} (${pct(arm.initialDetectionRate)})` : '—';
    const reviewerHits = arm.initialReviewerPasses
      ? `${arm.initialReviewerHits}/${arm.initialReviewerPasses} (${pct(arm.initialReviewerHitRate)})`
      : '—';
    lines.push(
      `| ${arm.topology} | ${arm.panelRuns} | ${detection} | ${reviewerHits} | ${arm.initialFindings} | ${arm.totalFindings} | ${arm.adjudicatedFindings} |`,
    );
  }

  lines.push('', '## Initial reviewer / protocol signal', '');
  lines.push('| Arm | Reviewer / protocol | Initial passes | Hits | Findings |');
  lines.push('|---|---|---:|---:|---:|');
  let reviewerRows = 0;
  for (const arm of report.arms) {
    for (const reviewer of arm.reviewers) {
      reviewerRows += 1;
      lines.push(`| ${arm.topology} | ${reviewer.label} | ${reviewer.initialPasses} | ${reviewer.initialHits} | ${reviewer.initialFindings} |`);
    }
  }
  if (!reviewerRows) lines.push('| — | — | 0 | 0 | 0 |');

  const planned = report.arms.filter((arm) => arm.protocolSelections.length > 0);
  if (planned.length) {
    lines.push('', '## Perspective protocol selections', '');
    lines.push('| Arm | Protocol | Selections |');
    lines.push('|---|---|---:|');
    for (const arm of planned) {
      for (const item of arm.protocolSelections) {
        lines.push(`| ${arm.topology} | ${item.protocol} | ${item.selections} |`);
      }
    }
  }

  lines.push('', '## Per-run panel signal', '');
  lines.push('| Arm | Scenario | Repeat | Mode | Initial detection | Reviewer hits | Initial findings | Terra adjudicated findings |');
  lines.push('|---|---|---:|---|:---:|---:|---:|---:|');
  for (const run of report.runs) {
    const signal = run.signal;
    lines.push(
      `| ${run.topology} | ${run.scenario} | ${run.repeat} | ${signal.reviewMode ?? '—'} | `
      + `${signal.initialReviewerPasses ? (signal.initialPanelDetected ? '✓' : '✗') : '—'} | `
      + `${signal.initialReviewerHits}/${signal.initialReviewerPasses} | ${signal.initialFindings} | ${signal.adjudicatedFindings} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const root = path.resolve(argv[0] ?? '.');
  const jsonOut = path.resolve(argv[1] ?? path.join(root, 'perspective-review-report.json'));
  const markdownOut = path.resolve(argv[2] ?? path.join(root, 'perspective-review-report.md'));
  const report = buildPerspectiveReviewReport(root);
  fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownOut, `${markdownReport(report)}\n`, 'utf8');
  process.stdout.write(`${markdownReport(report)}\n`);
}

if (require.main === module) main();

module.exports = {
  panelSignal,
  loadRun,
  aggregateReviewerSignal,
  aggregateProtocolSelections,
  aggregateArm,
  buildPerspectiveReviewReport,
  markdownReport,
};