#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CASES = Object.freeze({
  's08-symlink-reentry': Object.freeze({ expectedDefect: true, defectId: 'symlink_escape_reentry' }),
  's09-mappingproxy': Object.freeze({ expectedDefect: true, defectId: 'general_mapping_mappingproxy' }),
  's10-baseexception': Object.freeze({ expectedDefect: true, defectId: 'baseexception_cleanup_once' }),
  's09-clean': Object.freeze({ expectedDefect: false, defectId: null }),
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function findingText(finding = {}) {
  return [finding.severity, finding.title, finding.file, finding.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function matchesExpectedDefect(caseId, finding) {
  const text = findingText(finding);
  if (caseId === 's08-symlink-reentry') {
    return /symlink/.test(text)
      && /(re[- ]?entr|intermediate|component|travers|escape[^.]{0,80}\.\.|\.\.[^.]|resolution history)/.test(text);
  }
  if (caseId === 's09-mappingproxy') {
    return /(mappingproxy|mapping proxy)/.test(text)
      || (/deepcopy/.test(text) && /(mapping|proxy|pickle)/.test(text))
      || (/pickle/.test(text) && /mapping/.test(text));
  }
  if (caseId === 's10-baseexception') {
    return /(baseexception|keyboardinterrupt|systemexit|generator(exit)?|except\s+exception)/.test(text);
  }
  return false;
}

function findRunDirectories(root) {
  const files = walk(root).filter((file) => path.basename(file) === 'reviewer-only-result.json');
  return files.map((resultFile) => path.dirname(resultFile));
}

function loadRuns(root) {
  return findRunDirectories(root).map((dir) => {
    const result = readJson(path.join(dir, 'reviewer-only-result.json'));
    const metaPath = path.join(dir, 'benchmark-meta.json');
    const meta = fs.existsSync(metaPath) ? readJson(metaPath) : {};
    const caseId = String(meta.caseId ?? '').trim();
    const caseSpec = CASES[caseId];
    if (!caseSpec) throw new Error(`Unknown or missing reviewer-only case id in ${dir}: ${JSON.stringify(caseId)}`);
    const findings = (result.reports ?? []).flatMap((report) =>
      (report.findings ?? []).map((finding) => ({
        reviewerId: report.reviewerId,
        reviewerLabel: report.label,
        modelId: report.modelId,
        ...finding,
      })),
    );
    const expectedHits = caseSpec.expectedDefect
      ? findings.filter((finding) => matchesExpectedDefect(caseId, finding))
      : [];
    return {
      dir,
      caseId,
      repeat: Number(meta.repeat ?? 1),
      arm: result.arm,
      armLabel: result.armLabel,
      status: result.status,
      expectedDefect: caseSpec.expectedDefect,
      defectId: caseSpec.defectId,
      reports: result.reports ?? [],
      findings,
      expectedHits,
      detected: caseSpec.expectedDefect ? expectedHits.length > 0 : null,
      falsePositive: !caseSpec.expectedDefect ? findings.length > 0 : null,
      usage: result.usage ?? {},
    };
  });
}

function mean(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function summarize(runs) {
  const arms = [...new Set(runs.map((run) => run.arm))].sort();
  return arms.map((arm) => {
    const selected = runs.filter((run) => run.arm === arm);
    const defective = selected.filter((run) => run.expectedDefect);
    const clean = selected.filter((run) => !run.expectedDefect);
    const hits = defective.filter((run) => run.detected).length;
    const falsePositives = clean.filter((run) => run.falsePositive).length;
    return {
      arm,
      label: selected[0]?.armLabel ?? arm,
      runs: selected.length,
      defectiveCases: defective.length,
      defectHits: hits,
      defectRecall: defective.length ? hits / defective.length : null,
      cleanCases: clean.length,
      cleanFalsePositives: falsePositives,
      cleanFalsePositiveRate: clean.length ? falsePositives / clean.length : null,
      averageAiCredits: mean(selected.map((run) => run.usage?.aiCredits)),
      averageCalls: mean(selected.map((run) => run.usage?.calls)),
      averageInputTokens: mean(selected.map((run) => run.usage?.inputTokens)),
      averageElapsedMs: mean(selected.map((run) => run.usage?.elapsedMs)),
    };
  });
}

function pct(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function markdown(runs, summary) {
  const lines = [
    '# Equalized Reviewer-Only Benchmark',
    '',
    'Implementation and remediation are excluded. Every architecture reviews a frozen snapshot with equalized review methodology/tool access.',
    '',
    '| Architecture | Defect recall | Clean false-positive rate | Avg credits | Avg calls |',
    '|---|---:|---:|---:|---:|',
    ...summary.map((entry) => `| ${entry.arm} | ${entry.defectHits}/${entry.defectiveCases} (${pct(entry.defectRecall)}) | ${entry.cleanFalsePositives}/${entry.cleanCases} (${pct(entry.cleanFalsePositiveRate)}) | ${entry.averageAiCredits.toFixed(3)} | ${entry.averageCalls.toFixed(1)} |`),
    '',
    '## Runs',
    '',
    '| Arm | Case | Repeat | Expected | Detected | Findings | Credits | Calls |',
    '|---|---|---:|---|---|---:|---:|---:|',
    ...runs.sort((a, b) => `${a.caseId}-${a.arm}-${a.repeat}`.localeCompare(`${b.caseId}-${b.arm}-${b.repeat}`)).map((run) => {
      const expected = run.expectedDefect ? run.defectId : 'clean';
      const detected = run.expectedDefect ? (run.detected ? 'YES' : 'no') : (run.falsePositive ? 'FALSE POSITIVE' : 'clean');
      return `| ${run.arm} | ${run.caseId} | ${run.repeat} | ${expected} | ${detected} | ${run.findings.length} | ${Number(run.usage?.aiCredits ?? 0).toFixed(3)} | ${Number(run.usage?.calls ?? 0)} |`;
    }),
    '',
    '## Findings for manual verification',
    '',
  ];
  for (const run of runs) {
    if (!run.findings.length) continue;
    lines.push(`### ${run.arm} · ${run.caseId} · r${run.repeat}`);
    for (const finding of run.findings) {
      const expected = run.expectedDefect && matchesExpectedDefect(run.caseId, finding) ? ' [expected-hit]' : '';
      lines.push(`- **${finding.reviewerLabel ?? finding.reviewerId}**${expected}: ${finding.title ?? '(untitled)'}${finding.file ? ` (${finding.file})` : ''} — ${finding.description ?? ''}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  const root = path.resolve(argv[0] ?? '.');
  const jsonOutput = path.resolve(argv[1] ?? path.join(root, 'reviewer-only-report.json'));
  const mdOutput = path.resolve(argv[2] ?? path.join(root, 'reviewer-only-report.md'));
  const runs = loadRuns(root);
  const summary = summarize(runs);
  fs.writeFileSync(jsonOutput, `${JSON.stringify({ runs, summary }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdOutput, markdown(runs, summary), 'utf8');
  process.stdout.write(markdown(runs, summary));
}

if (require.main === module) main();

module.exports = {
  CASES,
  findingText,
  matchesExpectedDefect,
  loadRuns,
  summarize,
  markdown,
};
