#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function findEventsFile(dir) {
  const audit = path.join(dir, 'audit');
  if (!fs.existsSync(audit)) return null;
  for (const entry of fs.readdirSync(audit, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(audit, entry.name, 'events.jsonl');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function eventStats(file) {
  const stats = {
    reviewerCycles: 0,
    reviewerFindings: 0,
    workerPasses: 0,
    workerChangedPasses: 0,
    convergenceEvents: 0,
    recoveryReports: 0,
  };
  if (!file) return stats;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'strong_review_result') {
      stats.reviewerCycles += 1;
      stats.reviewerFindings += Array.isArray(event.review?.findings) ? event.review.findings.length : 0;
    } else if (event.type === 'worker_pass_result') {
      stats.workerPasses += 1;
      if (event.changed) stats.workerChangedPasses += 1;
    } else if (event.type === 'workers_converged') {
      stats.convergenceEvents += 1;
    } else if (event.type === 'recovery_report') {
      stats.recoveryReports += 1;
    }
  }
  return stats;
}

function actualModels(result) {
  if (Array.isArray(result?.actualRoleModels) && result.actualRoleModels.length) {
    return result.actualRoleModels.map((entry) => ({
      agent: entry.agent,
      role: entry.role,
      modelId: entry.modelId,
      modelName: entry.modelName,
      reasoningEffort: entry.reasoningEffort,
    }));
  }
  return (result?.usage?.agents ?? []).map((agent) => ({
    agent: agent.label ?? agent.agent,
    role: null,
    modelId: agent.modelId ?? null,
    modelName: agent.model ?? null,
    reasoningEffort: null,
  }));
}

function summarizeArm(dir) {
  const root = path.resolve(dir);
  const result = readJson(path.join(root, 'result.json'), {});
  const acceptance = readJson(path.join(root, 'scenario03-acceptance.json'), {});
  const efficiency = readJson(path.join(root, 'efficiency-summary.json'), {});
  const armStatus = readJson(path.join(root, 'arm-status.json'), {});
  const checks = Array.isArray(acceptance.checks) ? acceptance.checks : [];
  const failures = checks.filter((check) => check.ok !== true);
  const events = eventStats(findEventsFile(root));
  const usage = result.usage ?? {};
  const budget = result.budget ?? {};

  return {
    architecture: result.architecture?.id ?? path.basename(root),
    topology: result.architecture?.topology ?? null,
    selectors: result.architecture?.selectors ?? {},
    actualRoleModels: actualModels(result),
    runStatus: result.status ?? null,
    runExit: armStatus.runExit ?? null,
    oraclePass: acceptance.ok === true,
    oracleChecksPassed: checks.filter((check) => check.ok === true).length,
    oracleChecksTotal: checks.length,
    failedChecks: failures.map((check) => ({ name: check.name, error: check.error ?? null })),
    modelCalls: Number(usage.calls ?? efficiency.modelCalls ?? 0),
    promptSends: Number(efficiency.promptSends ?? usage.turns ?? 0),
    toolCalls: Number(efficiency.toolCalls ?? 0),
    turns: Number(usage.turns ?? 0),
    elapsedMs: Number(usage.elapsedMs ?? 0),
    aiCredits: Number(usage.aiCredits ?? 0),
    inputTokens: Number(usage.inputTokens ?? 0),
    outputTokens: Number(usage.outputTokens ?? 0),
    reasoningTokens: Number(usage.reasoningTokens ?? 0),
    cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
    maxContextTokens: Number(usage.maxContextTokens ?? 0),
    chatRequestDelta: Number(budget.chatRequestsUsed ?? efficiency.chatQuota?.deltaUsedRequests ?? 0),
    reviewerCycles: events.reviewerCycles,
    reviewerFindings: events.reviewerFindings,
    workerPasses: events.workerPasses,
    workerChangedPasses: events.workerChangedPasses,
    convergenceEvents: events.convergenceEvents,
    recoveryReports: events.recoveryReports,
  };
}

function csvCell(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows) {
  const columns = [
    'architecture', 'oraclePass', 'oracleChecksPassed', 'oracleChecksTotal',
    'modelCalls', 'promptSends', 'toolCalls', 'turns', 'elapsedMs', 'aiCredits',
    'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens',
    'maxContextTokens', 'chatRequestDelta', 'reviewerCycles', 'reviewerFindings',
    'workerPasses', 'workerChangedPasses', 'convergenceEvents', 'recoveryReports',
    'selectors', 'actualRoleModels', 'failedChecks',
  ];
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')),
  ].join('\n') + '\n';
}

function main(argv = process.argv.slice(2)) {
  if (argv.length < 3) {
    console.error('Usage: node src/headless/architecture-summary.js <output.json> <output.csv> <arm-dir> [arm-dir...]');
    return 2;
  }
  const [jsonOutput, csvOutput, ...dirs] = argv;
  const rows = dirs.map(summarizeArm);
  fs.mkdirSync(path.dirname(path.resolve(jsonOutput)), { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(csvOutput)), { recursive: true });
  fs.writeFileSync(path.resolve(jsonOutput), `${JSON.stringify({ runs: rows }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.resolve(csvOutput), toCsv(rows), 'utf8');
  process.stdout.write(`${JSON.stringify({ runs: rows }, null, 2)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  readJson,
  findEventsFile,
  eventStats,
  actualModels,
  summarizeArm,
  csvCell,
  toCsv,
  main,
};
