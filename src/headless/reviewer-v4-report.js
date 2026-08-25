#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CASE_DEFECTS = Object.freeze({
  'v4-s15-lease-multidefect': ['renew_rotates_and_invalidates_old', 'baseexception_cleanup'],
  'v4-s15-lease-clean': [],
  'v4-s16-authcache-multidefect': ['tenant_isolation', 'explicit_deny_overrides_wildcard'],
  'v4-s16-authcache-clean': [],
  'v4-s17-headers-multidefect': ['scalar_string_atomic', 'casefold_collision_merge_first_spelling'],
  'v4-s17-headers-clean': [],
  'v4-s18-retrytxn-multidefect': ['nested_state_rollback', 'permanent_error_not_retried', 'baseexception_rollback'],
  'v4-s18-retrytxn-clean': [],
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
  return [finding.severity, finding.title, finding.file, finding.description]
    .filter(Boolean).join(' ').toLowerCase();
}

function matchesDefect(defect, finding) {
  const text = findingText(finding);
  switch (defect) {
    case 'renew_rotates_and_invalidates_old':
      return /(renew|lease|token|generation)/.test(text) && /(generation|rotate|fresh|stale|invalidat|same token|same generation)/.test(text);
    case 'baseexception_cleanup':
      return /(baseexception|keyboardinterrupt|systemexit|exception hierarchy|non-exception|outside.*exception)/.test(text)
        && /(cleanup|release|lease|run)/.test(text);
    case 'tenant_isolation':
      return /tenant/.test(text) && /(cache|key|bleed|cross|isolation|reuse)/.test(text);
    case 'explicit_deny_overrides_wildcard':
      return /(wildcard|\*)/.test(text) && /(deny|false|precedence|override|explicit)/.test(text);
    case 'scalar_string_atomic':
      return /string/.test(text) && /(sequence|character|char|split|atomic|iterat)/.test(text);
    case 'casefold_collision_merge_first_spelling':
      return /(casefold|case-insensitive|case insensitive|collision|same header)/.test(text)
        && /(merge|concatenat|overwrite|first spelling|first key|lose|lost)/.test(text);
    case 'nested_state_rollback':
      return /(nested|shallow|deepcopy|deep copy|alias)/.test(text) && /(rollback|retry|state|leak|snapshot)/.test(text);
    case 'permanent_error_not_retried':
      return /(permanent|non-transient|non transient|all exception|broad exception)/.test(text) && /retr/.test(text);
    case 'baseexception_rollback':
      return /(baseexception|keyboardinterrupt|systemexit|outside.*exception|non-exception)/.test(text)
        && /(rollback|state|transaction)/.test(text);
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
      const findings = (result.reports ?? []).flatMap((report) =>
        (report.findings ?? []).map((finding) => ({
          reviewerId: report.reviewerId,
          reviewerLabel: report.label,
          ...finding,
        })),
      );
      const expectedDefects = CASE_DEFECTS[meta.caseId] ?? [];
      const defectHits = Object.fromEntries(expectedDefects.map((defect) => [
        defect,
        findings.filter((finding) => matchesDefect(defect, finding)),
      ]));
      const reviewerHits = Object.fromEntries(expectedDefects.map((defect) => [
        defect,
        [...new Set(defectHits[defect].map((finding) => finding.reviewerId))],
      ]));
      const detectedDefects = expectedDefects.filter((defect) => defectHits[defect].length > 0);
      const uniqueReviewerContributions = Object.fromEntries(
        expectedDefects
          .filter((defect) => reviewerHits[defect].length === 1)
          .map((defect) => [defect, reviewerHits[defect][0]]),
      );
      return {
        caseId: meta.caseId,
        repeat: Number(meta.repeat ?? 1),
        arm: result.arm,
        armLabel: result.armLabel,
        expectedDefects,
        detectedDefects,
        defectHits,
        reviewerHits,
        uniqueReviewerContributions,
        findings,
        cleanFindingCount: expectedDefects.length === 0 ? findings.length : 0,
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
    const expectedDefects = defective.reduce((sum, run) => sum + run.expectedDefects.length, 0);
    const defectHits = defective.reduce((sum, run) => sum + run.detectedDefects.length, 0);
    const uniqueContributions = defective.reduce((sum, run) => sum + Object.keys(run.uniqueReviewerContributions).length, 0);
    return {
      arm,
      cases: selected.length,
      defectHits,
      expectedDefects,
      defectRecall: expectedDefects ? defectHits / expectedDefects : null,
      cleanCases: clean.length,
      cleanCasesWithFindings: clean.filter((run) => run.cleanFindingCount > 0).length,
      cleanFindings: clean.reduce((sum, run) => sum + run.cleanFindingCount, 0),
      uniqueContributions,
      averageAiCredits: mean(selected.map((run) => run.usage.aiCredits)),
      averageCalls: mean(selected.map((run) => run.usage.calls)),
      averageInputTokens: mean(selected.map((run) => run.usage.inputTokens)),
    };
  });
}

function pct(value) { return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`; }

function markdown(runs, summary) {
  const lines = [
    '# Reviewer V4 Hard-Corpus Benchmark', '',
    '> Clean-control findings require manual verification before they are classified as false positives.', '',
    '| Architecture | Seeded recall | Clean cases with findings | Clean findings | Unique single-reviewer contributions | Avg credits | Avg calls |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...summary.map((s) => `| ${s.arm} | ${s.defectHits}/${s.expectedDefects} (${pct(s.defectRecall)}) | ${s.cleanCasesWithFindings}/${s.cleanCases} | ${s.cleanFindings} | ${s.uniqueContributions} | ${s.averageAiCredits.toFixed(3)} | ${s.averageCalls.toFixed(1)} |`),
    '', '## Runs', '',
    '| Arm | Case | Seeded defects | Individual reviewer hit counts | Findings | Credits |',
    '|---|---|---|---|---:|---:|',
  ];
  for (const run of runs.sort((a,b) => `${a.caseId}-${a.arm}`.localeCompare(`${b.caseId}-${b.arm}`))) {
    const detected = run.expectedDefects.length ? `${run.detectedDefects.length}/${run.expectedDefects.length}` : (run.cleanFindingCount ? `clean + ${run.cleanFindingCount} finding(s)` : 'clean');
    const reviewerCounts = run.expectedDefects.map((d) => `${d}:${run.reviewerHits[d]?.length ?? 0}`).join('<br>') || '-';
    lines.push(`| ${run.arm} | ${run.caseId} | ${detected} | ${reviewerCounts} | ${run.findings.length} | ${Number(run.usage.aiCredits ?? 0).toFixed(3)} |`);
  }
  lines.push('', '## Findings', '');
  for (const run of runs) {
    if (!run.findings.length) continue;
    lines.push(`### ${run.arm} · ${run.caseId}`);
    for (const finding of run.findings) {
      const matches = run.expectedDefects.filter((defect) => matchesDefect(defect, finding));
      lines.push(`- **${finding.reviewerLabel ?? finding.reviewerId}**${matches.length ? ` [${matches.join(', ')}]` : ''}: ${finding.title ?? '(untitled)'} — ${finding.description ?? ''}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  const root = path.resolve(argv[0] ?? '.');
  const jsonOutput = path.resolve(argv[1] ?? path.join(root, 'reviewer-v4-report.json'));
  const mdOutput = path.resolve(argv[2] ?? path.join(root, 'reviewer-v4-report.md'));
  const runs = loadRuns(root);
  const summary = summarize(runs);
  fs.writeFileSync(jsonOutput, `${JSON.stringify({ runs, summary }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdOutput, markdown(runs, summary), 'utf8');
  process.stdout.write(markdown(runs, summary));
}

if (require.main === module) main();

module.exports = { CASE_DEFECTS, findingText, matchesDefect, loadRuns, summarize, markdown };
