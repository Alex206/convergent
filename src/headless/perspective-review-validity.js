#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PANEL_ARMS = Object.freeze({
  'generic-luna-panel-terra': new Set(['custom:report_review']),
  'perspective-luna-terra': new Set(['custom:report_review_plan', 'custom:report_review']),
});

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Keep validity inspection robust to a truncated final audit line.
    }
  }
  return rows;
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

function normalizedTool(tool) {
  const value = String(tool ?? '');
  return value.includes(':') ? value : `custom:${value}`;
}

function inspectAudit(file) {
  const events = readJsonLines(file);
  const topology = events.find((event) => PANEL_ARMS[event.topology])?.topology ?? null;
  if (!topology) return null;

  const allowed = PANEL_ARMS[topology];
  const toolDeclarations = events.filter(
    (event) => event.type === 'agent_tools' && event.agent === 'Terra review controller',
  );
  const toolStarts = events.filter(
    (event) => event.type === 'tool_start' && event.agent === 'Terra review controller',
  );

  const declared = [...new Set(toolDeclarations.flatMap((event) => (
    Array.isArray(event.tools) ? event.tools.map(String) : []
  )))];
  const used = [...new Set(toolStarts.map((event) => normalizedTool(event.tool ?? event.data?.toolName)))];
  const unexpectedDeclared = declared.filter((tool) => !allowed.has(tool));
  const unexpectedUsed = used.filter((tool) => !allowed.has(tool));

  return {
    auditFile: file,
    topology,
    expectedTools: [...allowed],
    declaredTools: declared,
    usedTools: used,
    unexpectedDeclared,
    unexpectedUsed,
    ok: toolDeclarations.length > 0
      && unexpectedDeclared.length === 0
      && unexpectedUsed.length === 0,
  };
}

function buildValidityReport(root) {
  const runs = findFiles(root, 'events.jsonl')
    .map(inspectAudit)
    .filter(Boolean);
  const invalid = runs.filter((run) => !run.ok);
  return {
    generatedAt: new Date().toISOString(),
    root: path.resolve(root),
    panelRuns: runs.length,
    invalidRuns: invalid.length,
    ok: runs.length > 0 && invalid.length === 0,
    runs,
  };
}

function markdownReport(report) {
  const lines = [
    '# Perspective review causal-isolation validity',
    '',
    `Panel runs inspected: ${report.panelRuns}; invalid: ${report.invalidRuns}; isolation: ${report.ok ? 'PASS' : 'FAIL'}.`,
    '',
    '| Arm | Declared Terra tools | Used Terra tools | Isolation |',
    '|---|---|---|:---:|',
  ];
  for (const run of report.runs) {
    lines.push(
      `| ${run.topology} | ${run.declaredTools.join(', ') || '—'} | ${run.usedTools.join(', ') || '—'} | ${run.ok ? 'PASS' : 'FAIL'} |`,
    );
    if (!run.ok) {
      lines.push(
        `| ↳ unexpected | ${run.unexpectedDeclared.join(', ') || '—'} | ${run.unexpectedUsed.join(', ') || '—'} | — |`,
      );
    }
  }
  if (!report.runs.length) lines.push('| — | — | — | FAIL |');
  lines.push('');
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const root = path.resolve(argv[0] ?? '.');
  const jsonOut = path.resolve(argv[1] ?? path.join(root, 'perspective-review-validity.json'));
  const markdownOut = path.resolve(argv[2] ?? path.join(root, 'perspective-review-validity.md'));
  const assertValid = argv.includes('--assert');
  const report = buildValidityReport(root);
  fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownOut, `${markdownReport(report)}\n`, 'utf8');
  process.stdout.write(`${markdownReport(report)}\n`);
  if (assertValid && !report.ok) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = {
  PANEL_ARMS,
  normalizedTool,
  inspectAudit,
  buildValidityReport,
  markdownReport,
};