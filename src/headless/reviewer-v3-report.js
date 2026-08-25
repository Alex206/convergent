#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFECTS = Object.freeze([
  'unsupported_version_zero',
  'reserved_flags_rejected',
  'invalid_checksum_non_destructive',
]);

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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function findingText(finding = {}) {
  return [finding.severity, finding.title, finding.file, finding.description]
    .filter(Boolean).join(' ').toLowerCase();
}

function matchesDefect(defect, finding) {
  const text = findingText(finding);
  if (defect === 'unsupported_version_zero') {
    return /(version|protocol)/.test(text)
      && /(version\s*0|0\s*(is|being|gets|accepted|allowed)|zero|!=|greater-than|greater than)/.test(text);
  }
  if (defect === 'reserved_flags_rejected') {
    return /(flag|flags)/.test(text)
      && /(reserved|high nibble|upper nibble|0x10|0x80|mask|silently|discard)/.test(text);
  }
  if (defect === 'invalid_checksum_non_destructive') {
    return /checksum/.test(text)
      && /(mutat|consume|delete|delet|destroy|truncate|unchanged|buffer|state)/.test(text);
  }
  return false;
}

function loadRuns(root) {
  const resultFiles = walk(root).filter((file) => path.basename(file) === 'reviewer-only-result.json');
  return resultFiles.map((resultFile) => {
    const dir = path.dirname(resultFile);
    const result = readJson(resultFile);
    const meta = readJson(path.join(dir, 'benchmark-meta.json'));
    const findings = (result.reports ?? []).flatMap((report) =>
      (report.findings ?? []).map((finding) => ({
        reviewerId: report.reviewerId,
        reviewerLabel: report.label,
        ...finding,
      })),
    );
    const expectedDefects = meta.caseId === 'v3-s14-wireframe-multidefect' ? DEFECTS : [];
    const defectHits = Object.fromEntries(expectedDefects.map((defect) => [
      defect,
      findings.filter((finding) => matchesDefect(defect, finding)),
    ]));
    const reviewerHits = Object.fromEntries(expectedDefects.map((defect) => [
      defect,
      [...new Set(defectHits[defect].map((finding) => finding.reviewerId))],
    ]));
    return {
      caseId: meta.caseId,
      repeat: Number(meta.repeat ?? 1),
      arm: result.arm,
      armLabel: result.armLabel,
      expectedDefects,
      detectedDefects: expectedDefects.filter((defect) => defectHits[defect].length > 0),
      defectHits,
      reviewerHits,
      findings,
      falsePositive: expectedDefects.length === 0 && findings.length > 0,
      usage: result.usage ?? {},
    };
  });
}

function mean(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function summarize(runs) {
  return [...new Set(runs.map((run) => run.arm))].sort().map((arm) => {
    const selected = runs.filter((run) => run.arm === arm);
    const defective = selected.filter((run) => run.expectedDefects.length);
    const clean = selected.filter((run) => !run.expectedDefects.length);
    const totalExpected = defective.reduce((sum, run) => sum + run.expectedDefects.length, 0);
    const totalDetected = defective.reduce((sum, run) => sum + run.detectedDefects.length, 0);
    return {
      arm,
      cases: selected.length,
      defectHits: totalDetected,
      expectedDefects: totalExpected,
      defectRecall: totalExpected ? totalDetected / totalExpected : null,
      cleanFalsePositives: clean.filter((run) => run.falsePositive).length,
      cleanCases: clean.length,
      averageAiCredits: mean(selected.map((run) => run.usage.aiCredits)),
      averageCalls: mean(selected.map((run) => run.usage.calls)),
      averageInputTokens: mean(selected.map((run) => run.usage.inputTokens)),
    };
  });
}

function pct(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function markdown(runs, summary) {
  const lines = [
    '# Reviewer V3 Multi-Defect Benchmark', '',
    '| Architecture | Defect recall | Clean FP | Avg credits | Avg calls |',
    '|---|---:|---:|---:|---:|',
    ...summary.map((s) => `| ${s.arm} | ${s.defectHits}/${s.expectedDefects} (${pct(s.defectRecall)}) | ${s.cleanFalsePositives}/${s.cleanCases} | ${s.averageAiCredits.toFixed(3)} | ${s.averageCalls.toFixed(1)} |`),
    '', '## Runs', '',
    '| Arm | Case | Detected defects | Individual reviewer hit counts | Findings | Credits |',
    '|---|---|---|---|---:|---:|',
  ];
  for (const run of runs.sort((a,b) => `${a.caseId}-${a.arm}`.localeCompare(`${b.caseId}-${b.arm}`))) {
    const detected = run.expectedDefects.length ? `${run.detectedDefects.length}/${run.expectedDefects.length}` : (run.falsePositive ? 'FALSE POSITIVE' : 'clean');
    const reviewerCounts = run.expectedDefects.map((d) => `${d}:${run.reviewerHits[d]?.length ?? 0}`).join('<br>') || '-';
    lines.push(`| ${run.arm} | ${run.caseId} | ${detected} | ${reviewerCounts} | ${run.findings.length} | ${Number(run.usage.aiCredits ?? 0).toFixed(3)} |`);
  }
  lines.push('', '## Findings', '');
  for (const run of runs) {
    if (!run.findings.length) continue;
    lines.push(`### ${run.arm} · ${run.caseId}`);
    for (const finding of run.findings) {
      const matches = run.expectedDefects.filter((d) => matchesDefect(d, finding));
      lines.push(`- **${finding.reviewerLabel ?? finding.reviewerId}**${matches.length ? ` [${matches.join(', ')}]` : ''}: ${finding.title ?? '(untitled)'} — ${finding.description ?? ''}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  const root = path.resolve(argv[0] ?? '.');
  const jsonOutput = path.resolve(argv[1] ?? path.join(root, 'reviewer-v3-report.json'));
  const mdOutput = path.resolve(argv[2] ?? path.join(root, 'reviewer-v3-report.md'));
  const runs = loadRuns(root);
  const summary = summarize(runs);
  fs.writeFileSync(jsonOutput, `${JSON.stringify({ runs, summary }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdOutput, markdown(runs, summary), 'utf8');
  process.stdout.write(markdown(runs, summary));
}

if (require.main === module) main();

module.exports = { DEFECTS, findingText, matchesDefect, loadRuns, summarize, markdown };
