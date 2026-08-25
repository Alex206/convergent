#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CASE_DEFECTS = Object.freeze({
  'v6-h15-validation-language-regression': ['successful_validation_negative_case_false_positive'],
  'v6-h15-validation-language-fixed': [],
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
  if (defect !== 'successful_validation_negative_case_false_positive') return false;
  return /(validation|validator|check)/.test(text)
    && /(pass|success|successful|clean)/.test(text)
    && /(missing|negative|error|credential|token)/.test(text)
    && /(block|reconcil|false positive|misclass|classif)/.test(text);
}

function loadRuns(root) {
  return walk(root)
    .filter((file) => path.basename(file) === 'reviewer-only-result.json')
    .map((resultFile) => {
      const dir = path.dirname(resultFile);
      const result = readJson(resultFile);
      const meta = readJson(path.join(dir, 'benchmark-meta.json'));
      const findings = (result.reports ?? []).flatMap((report) =>
        (report.findings ?? []).map((finding) => ({ reviewerId: report.reviewerId, reviewerLabel: report.label, ...finding })),
      );
      const expectedDefects = CASE_DEFECTS[meta.caseId] ?? [];
      const reviewerHits = Object.fromEntries(expectedDefects.map((defect) => [
        defect,
        [...new Set(findings.filter((finding) => matchesDefect(defect, finding)).map((finding) => finding.reviewerId))],
      ]));
      const detectedDefects = expectedDefects.filter((defect) => reviewerHits[defect].length > 0);
      return { caseId: meta.caseId, arm: result.arm, expectedDefects, detectedDefects, reviewerHits, findings, usage: result.usage ?? {} };
    });
}
function mean(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : 0;
}
function summarize(runs) {
  return [...new Set(runs.map((run) => run.arm))].sort().map((arm) => {
    const selected = runs.filter((run) => run.arm === arm);
    const defective = selected.filter((run) => run.expectedDefects.length);
    const expected = defective.reduce((sum, run) => sum + run.expectedDefects.length, 0);
    const hits = defective.reduce((sum, run) => sum + run.detectedDefects.length, 0);
    const individualOpportunities = defective.reduce((sum, run) => sum + run.expectedDefects.length * 3, 0);
    const individualHits = defective.reduce((sum, run) => sum + run.expectedDefects.reduce((n, defect) => n + run.reviewerHits[defect].length, 0), 0);
    return {
      arm,
      seededHits: hits,
      seededExpected: expected,
      individualHits,
      individualOpportunities,
      averageCredits: mean(selected.map((run) => run.usage.aiCredits)),
      averageCalls: mean(selected.map((run) => run.usage.calls)),
      averageInputTokens: mean(selected.map((run) => run.usage.inputTokens)),
    };
  });
}
function markdown(runs, summary) {
  const lines = [
    '# Reviewer V6 Historical Semantic Benchmark', '',
    '> Automated matching is only a screening aid. Raw findings and fixed-snapshot findings require manual semantic audit.', '',
    '| Architecture | Seeded recall | Individual reviewer seeded hits | Avg credits | Avg calls | Avg input tokens |',
    '|---|---:|---:|---:|---:|---:|',
    ...summary.map((s) => `| ${s.arm} | ${s.seededHits}/${s.seededExpected} | ${s.individualHits}/${s.individualOpportunities} | ${s.averageCredits.toFixed(3)} | ${s.averageCalls.toFixed(1)} | ${Math.round(s.averageInputTokens)} |`),
    '', '## Runs', '',
    '| Arm | Case | Seeded defects found | Reviewer hit counts | Findings | Credits |',
    '|---|---|---:|---|---:|---:|',
  ];
  for (const run of [...runs].sort((a,b) => `${a.caseId}-${a.arm}`.localeCompare(`${b.caseId}-${b.arm}`))) {
    const counts = run.expectedDefects.map((defect) => `${defect}:${run.reviewerHits[defect]?.length ?? 0}`).join('<br>') || '-';
    lines.push(`| ${run.arm} | ${run.caseId} | ${run.detectedDefects.length}/${run.expectedDefects.length} | ${counts} | ${run.findings.length} | ${Number(run.usage.aiCredits ?? 0).toFixed(3)} |`);
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
  const jsonOutput = path.resolve(argv[1] ?? path.join(root, 'reviewer-v6-report.json'));
  const mdOutput = path.resolve(argv[2] ?? path.join(root, 'reviewer-v6-report.md'));
  const runs = loadRuns(root);
  const summary = summarize(runs);
  fs.writeFileSync(jsonOutput, `${JSON.stringify({ runs, summary }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdOutput, markdown(runs, summary), 'utf8');
  process.stdout.write(markdown(runs, summary));
}
if (require.main === module) main();
module.exports = { CASE_DEFECTS, matchesDefect, loadRuns, summarize, markdown };
