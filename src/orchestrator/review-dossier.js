'use strict';

const MAX_REVIEW_DOSSIER_CYCLES = 12;
const MAX_REVIEW_DOSSIER_FINDINGS = 12;
const MAX_REVIEW_DOSSIER_CHECKS = 20;
const MAX_REVIEW_DOSSIER_TOOLS = 24;

function text(value, max = 1000) {
  const normalized = String(value ?? '').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

function normalizeFinding(value = {}) {
  return {
    severity: text(value.severity, 32) || 'medium',
    title: text(value.title, 200) || 'Review finding',
    description: text(value.description, 1200),
    ...(value.file ? { file: text(value.file, 500) } : {}),
  };
}

function normalizeUsage(value = {}) {
  return {
    inputTokens: number(value.inputTokens),
    outputTokens: number(value.outputTokens),
    reasoningTokens: number(value.reasoningTokens),
    cacheReadTokens: number(value.cacheReadTokens),
    cacheWriteTokens: number(value.cacheWriteTokens),
    calls: number(value.calls),
    turns: number(value.turns),
    totalNanoAiu: number(value.totalNanoAiu),
    aiCredits: number(value.aiCredits),
    durationMs: number(value.durationMs),
    hasCreditData: Boolean(value.hasCreditData),
  };
}

function addUsage(left = {}, right = {}) {
  const a = normalizeUsage(left);
  const b = normalizeUsage(right);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    calls: a.calls + b.calls,
    turns: a.turns + b.turns,
    totalNanoAiu: a.totalNanoAiu + b.totalNanoAiu,
    aiCredits: a.aiCredits + b.aiCredits,
    durationMs: a.durationMs + b.durationMs,
    hasCreditData: a.hasCreditData || b.hasCreditData,
  };
}

function normalizeTool(value = {}) {
  return {
    toolName: text(value.toolName, 120) || 'unknown',
    detail: text(value.detail, 800),
    success: value.success !== false,
    durationMs: value.durationMs === undefined ? undefined : number(value.durationMs),
  };
}

function normalizeReviewCycle(value = {}) {
  const report = value.report && typeof value.report === 'object' ? value.report : {};
  return {
    cycle: Math.max(1, Math.floor(number(value.cycle) || 1)),
    revision: text(value.revision, 160),
    verdict: text(value.verdict ?? report.verdict, 40),
    summary: text(value.summary ?? report.summary, 1600),
    findings: (Array.isArray(value.findings ?? report.findings) ? (value.findings ?? report.findings) : [])
      .slice(0, MAX_REVIEW_DOSSIER_FINDINGS)
      .map(normalizeFinding),
    checks: (Array.isArray(value.checks ?? report.checks) ? (value.checks ?? report.checks) : [])
      .map((item) => text(item, 600))
      .filter(Boolean)
      .slice(0, MAX_REVIEW_DOSSIER_CHECKS),
    tools: (Array.isArray(value.tools) ? value.tools : [])
      .slice(0, MAX_REVIEW_DOSSIER_TOOLS)
      .map(normalizeTool),
    usage: normalizeUsage(value.usage),
    integrityIncident: value.integrityIncident ?? null,
  };
}

function normalizeReviewDossier(value) {
  const cycles = Array.isArray(value?.cycles)
    ? value.cycles.slice(-MAX_REVIEW_DOSSIER_CYCLES).map(normalizeReviewCycle)
    : [];
  return { version: 1, cycles };
}

function uniqueStrings(values, limit) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = text(value, 600);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function appendReviewDossier(dossier, cycle) {
  const current = normalizeReviewDossier(dossier);
  const normalized = normalizeReviewCycle(cycle);
  const previous = current.cycles.find((item) => item.cycle === normalized.cycle);
  const merged = previous ? {
    ...normalized,
    checks: uniqueStrings([...(previous.checks ?? []), ...(normalized.checks ?? [])], MAX_REVIEW_DOSSIER_CHECKS),
    tools: [...(previous.tools ?? []), ...(normalized.tools ?? [])].slice(-MAX_REVIEW_DOSSIER_TOOLS),
    usage: addUsage(previous.usage, normalized.usage),
    integrityIncident: normalized.integrityIncident ?? previous.integrityIncident ?? null,
  } : normalized;
  const cycles = current.cycles.filter((item) => item.cycle !== normalized.cycle);
  cycles.push(merged);
  cycles.sort((a, b) => a.cycle - b.cycle);
  return { version: 1, cycles: cycles.slice(-MAX_REVIEW_DOSSIER_CYCLES) };
}

function formatReviewDossier(value) {
  const dossier = normalizeReviewDossier(value);
  if (!dossier.cycles.length) return '';
  const lines = [
    'DURABLE REVIEW DOSSIER FROM EARLIER CYCLES/EXECUTIONS:',
    'This is compact structured review history, not hidden reasoning. Reuse it to avoid rediscovering settled context, while verifying claims against the current revision where necessary.',
  ];
  for (const cycle of dossier.cycles) {
    const usage = cycle.usage;
    const credits = usage.hasCreditData ? `; ≈${usage.aiCredits.toFixed(3)} AI credits` : '';
    lines.push(`- R${cycle.cycle} @ ${cycle.revision || 'unknown'}: ${cycle.verdict || 'unknown'}; ${cycle.summary || '(no summary)'}; ${usage.inputTokens} in / ${usage.outputTokens} out / ${usage.reasoningTokens} reasoning${credits}`);
    for (const finding of cycle.findings) {
      lines.push(`  - finding [${finding.severity}] ${finding.title}${finding.file ? ` (${finding.file})` : ''}: ${finding.description}`);
    }
    if (cycle.checks.length) lines.push(`  - checks: ${cycle.checks.join(' | ')}`);
    if (cycle.tools.length) lines.push(`  - tools: ${cycle.tools.map((tool) => `${tool.toolName}${tool.detail ? `(${tool.detail})` : ''}`).join(' | ')}`);
    if (cycle.integrityIncident) lines.push('  - reviewer workspace-integrity incident occurred; the changed revision was sent through independent worker revalidation before acceptance.');
  }
  return lines.join('\n');
}

module.exports = {
  MAX_REVIEW_DOSSIER_CYCLES,
  normalizeReviewDossier,
  appendReviewDossier,
  formatReviewDossier,
  normalizeReviewCycle,
  addUsage,
};