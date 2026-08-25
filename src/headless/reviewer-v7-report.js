#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CASE_DEFECTS = Object.freeze({
  'v7-h15-latent-report-integrity': ['successful_validation_negative_case_false_positive'],
  'v7-h22-latent-turn-budget': ['accepted_report_order_invariance'],
  'v7-h23-latent-ci-gate': ['oracle_failure_propagates'],
});

function walk(root) {
  const result = [];
  if (!fs.existsSync(root)) return result;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else result.push(full);
  }
  return result;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function findingText(finding = {}) {
  return [finding.severity, finding.title, finding.file, finding.description].filter(Boolean).join(' ').toLowerCase();
}

function matchesDefect(defect, finding) {
  const text = findingText(finding);
  switch (defect) {
    case 'successful_validation_negative_case_false_positive':
      return /(validation|validator|check)/.test(text)
        && /(pass|success|successful|clean)/.test(text)
        && /(missing|negative|error|credential|token)/.test(text)
        && /(block|reconcil|false positive|misclass|classif)/.test(text);
    case 'accepted_report_order_invariance':
      return /(accepted|structured|report)/.test(text)
        && /(usage|assistant_usage|event order|ordering|late|after.*tool|tool.*before|cap|turn limit|budget)/.test(text);
    case 'oracle_failure_propagates':
      return /(oracle|acceptance|independent|validation|validator|benchmark)/.test(text)
        && /(continue-on-error|green|success|successful|ignore|swallow|propagat|fail the job|job fail)/.test(text)
        && /(fail|non-zero|nonzero|invalid|false)/.test(text);
    default:
      return false;
  }
}

function loadRuns(root) {
  return walk(root)
    .filter((file) => path.basename(file) === 'reviewer-only-result.json')
    .map((resultFile) => {
      const dir = path.dirname(resultFile);
      const result = readJson(resultFile);
      const meta = readJson(path.join(dir, 'benchmark-meta.json'));
      const reports = result.reports ?? [];
      const findings = reports.flatMap((report) =>
        (report.findings ?? []).map((finding) => ({ reviewerId: report.reviewerId, reviewerLabel: report.label, ...finding })),
      );
      const expectedDefects = CASE_DEFECTS[meta.caseId] ?? [];
      const reviewerHits = Object.fromEntries(expectedDefects.map((defect) => [
        defect,
        [...new Set(findings.filter((finding) => matchesDefect(defect, finding)).map((finding) => finding.reviewerId))],
      ]));
      const detectedDefects = expectedDefects.filter((defect) => reviewerHits[defect].length > 0);
      return {
        caseId: meta.caseId,
        arm: result.arm,
        reviewerCount: reports.length,
        expectedDefects,
        detectedDefects,
        reviewerHits,
        findings,
        reports,
        usage: result.usage ?? {},
      };
    });
}

function mean(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : 0;
}

function summarize(runs) {
  return [...new Set(runs.map((run) => run.arm))].sort().map((arm) => {
    const selected = runs.filter((run) => run.arm === arm);
    const expected = selected.reduce((sum, run) => sum + run.expectedDefects.length, 0);
    const hits = selected.reduce((sum, run) => sum + run.detectedDefects.length, 0);
    const individualOpportunities = selected.reduce(
      (sum, run) => sum + run.expectedDefects.length * run.reviewerCount,
      0,
    );
    const individualHits = selected.reduce(
      (sum, run) => sum + run.expectedDefects.reduce((n, defect) => n + run.reviewerHits[defect].length, 0),
      0,
    );
    return {
      arm,
      reviewerCount: selected[0]?.reviewerCount ?? 0,
      seededHits: hits,
      seededExpected: expected,
      casesWithHit: selected.filter((run) => run.detectedDefects.length === run.expectedDefects.length).length,
      caseCount: selected.length,
      individualHits,
      individualOpportunities,
      averageCredits: mean(selected.map((run) => run.usage.aiCredits)),
      totalCredits: selected.reduce((sum, run) => sum + Number(run.usage.aiCredits ?? 0), 0),
      averageCalls: mean(selected.map((run) => run.usage.calls)),
      averageInputTokens: mean(selected.map((run) => run.usage.inputTokens)),
    };
  });
}

function markdown(runs, summary) {
  const lines = [
    '# Reviewer V7 Latent Historical Panel-Size Frontier', '',
    '> The task contracts intentionally predate the known regressions. Automated matching is a screening aid; raw findings must be manually audited before architecture decisions.', '',
    '| Architecture | Reviewers | Seeded recall | Cases detected | Individual hits | Avg credits/case | Total credits | Avg calls | Avg input |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...summary.map((s) => `| ${s.arm} | ${s.reviewerCount} | ${s.seededHits}/${s.seededExpected} | ${s.casesWithHit}/${s.caseCount} | ${s.individualHits}/${s.individualOpportunities} | ${s.averageCredits.toFixed(3)} | ${s.totalCredits.toFixed(3)} | ${s.averageCalls.toFixed(1)} | ${Math.round(s.averageInputTokens)} |`),
    '', '## Runs', '',
    '| Arm | Case | Defect found | Reviewer hits | Findings | Credits | Calls |',
    '|---|---|---:|---|---:|---:|---:|',
  ];
  for (const run of [...runs].sort((a, b) => `${a.caseId}-${a.arm}`.localeCompare(`${b.caseId}-${b.arm}`))) {
    const counts = run.expectedDefects.map((defect) => `${defect}:${run.reviewerHits[defect]?.length ?? 0}/${run.reviewerCount}`).join('<br>') || '-';
    lines.push(`| ${run.arm} | ${run.caseId} | ${run.detectedDefects.length}/${run.expectedDefects.length} | ${counts} | ${run.findings.length} | ${Number(run.usage.aiCredits ?? 0).toFixed(3)} | ${Number(run.usage.calls ?? 0)} |`);
  }
  lines.push('', '## Findings', '');
  for (const run of runs) {
    if (!run.findings.length) continue;
    lines.push(`### ${run.arm} · ${run.caseId}`);
    for (const finding of run.findings) {
      const matched = run.expectedDefects.filter((defect) => matchesDefect(defect, finding));
      lines.push(`- **${finding.reviewerLabel ?? finding.reviewerId}**${matched.length ? ` [${matched.join(', ')}]` : ''}: ${finding.title ?? '(untitled)'} — ${finding.description ?? ''}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  const root = path.resolve(argv[0] ?? '.');
  const jsonOutput = path.resolve(argv[1] ?? path.join(root, 'reviewer-v7-report.json'));
  const mdOutput = path.resolve(argv[2] ?? path.join(root, 'reviewer-v7-report.md'));
  const runs = loadRuns(root);
  const summary = summarize(runs);
  fs.writeFileSync(jsonOutput, `${JSON.stringify({ runs, summary }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdOutput, markdown(runs, summary), 'utf8');
  process.stdout.write(markdown(runs, summary));
}

if (require.main === module) main();
module.exports = { CASE_DEFECTS, matchesDefect, loadRuns, summarize, markdown };
