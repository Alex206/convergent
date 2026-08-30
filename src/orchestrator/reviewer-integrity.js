'use strict';

const { buildTaskChangeManifest } = require('./task-change-manifest');

const MAX_INCIDENT_TOOLS = 24;
const MAX_INCIDENT_PATHS = 80;

function boundedString(value, max = 500) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolTraceDelta(before = {}, after = {}) {
  const beforeCount = Math.max(0, Number(before.completedCount) || 0);
  const afterCount = Math.max(0, Number(after.completedCount) || 0);
  const count = Math.max(0, afterCount - beforeCount);
  const completed = Array.isArray(after.completed) ? after.completed : [];
  if (!count || !completed.length) return [];
  return completed.slice(-Math.min(count, completed.length, MAX_INCIDENT_TOOLS)).map((item) => ({
    toolName: String(item.toolName ?? 'unknown'),
    detail: boundedString(item.detail, 800),
    success: item.success !== false,
    durationMs: item.durationMs === undefined ? undefined : Math.max(0, Number(item.durationMs) || 0),
  }));
}

function createReviewerMutationIncident({
  taskId,
  reviewCycle,
  beforeRevision,
  afterRevision,
  beforeState,
  afterState,
  beforeTrace,
  afterTrace,
  reviewerReport,
} = {}) {
  const manifest = beforeState && afterState
    ? buildTaskChangeManifest(beforeState, afterState)
    : null;
  const entries = Array.isArray(manifest?.entries)
    ? manifest.entries.slice(0, MAX_INCIDENT_PATHS).map((entry) => ({
      path: String(entry.path ?? ''),
      status: String(entry.status ?? ''),
      kind: String(entry.kind ?? ''),
    }))
    : [];
  return {
    taskId: String(taskId ?? ''),
    reviewCycle: Math.max(1, Number(reviewCycle) || 1),
    beforeRevision: String(beforeRevision ?? ''),
    afterRevision: String(afterRevision ?? ''),
    changedPaths: entries,
    changedPathCount: Number(manifest?.count) || entries.length,
    tools: toolTraceDelta(beforeTrace, afterTrace),
    reviewerReport: reviewerReport ? {
      verdict: String(reviewerReport.verdict ?? ''),
      summary: boundedString(reviewerReport.summary, 1200),
      checks: Array.isArray(reviewerReport.checks)
        ? reviewerReport.checks.map((item) => boundedString(item, 500)).filter(Boolean).slice(0, 20)
        : [],
    } : null,
  };
}

function formatReviewerMutationIncident(incident) {
  const lines = [
    'REVIEWER WORKSPACE-INTEGRITY INCIDENT:',
    `- task: ${incident.taskId || 'unknown'}`,
    `- review cycle: ${incident.reviewCycle}`,
    `- before fingerprint: ${incident.beforeRevision || 'unknown'}`,
    `- after fingerprint: ${incident.afterRevision || 'unknown'}`,
    `- changed paths detected during reviewer turn: ${incident.changedPathCount ?? 0}`,
  ];

  for (const entry of incident.changedPaths ?? []) {
    lines.push(`  - ${entry.status || '??'} ${entry.path}${entry.kind ? ` (${entry.kind})` : ''}`);
  }
  if ((incident.changedPathCount ?? 0) > (incident.changedPaths?.length ?? 0)) {
    lines.push(`  - ... ${(incident.changedPathCount ?? 0) - (incident.changedPaths?.length ?? 0)} additional changed path(s) omitted`);
  }

  lines.push(`- completed reviewer tools/commands in this turn: ${incident.tools?.length ?? 0}`);
  for (const tool of incident.tools ?? []) {
    lines.push(`  - ${tool.toolName}: ${tool.detail || '(no detail)'}; success=${tool.success ? 'yes' : 'no'}${tool.durationMs === undefined ? '' : `; ${tool.durationMs}ms`}`);
  }

  if (incident.reviewerReport) {
    lines.push(`- submitted reviewer verdict: ${incident.reviewerReport.verdict || 'unknown'}`);
    lines.push(`- submitted reviewer summary: ${incident.reviewerReport.summary || '(empty)'}`);
    if (incident.reviewerReport.checks?.length) {
      lines.push('- reviewer-reported checks:');
      for (const check of incident.reviewerReport.checks) lines.push(`  - ${check}`);
    }
  }

  lines.push(
    'The reviewer is a read-only acceptance gate. An explainable side effect is not self-approval: if the workspace fingerprint changed, the resulting revision must be independently revalidated by implementation worker(s) before any reviewer CLEAN can be accepted.',
  );
  return lines.join('\n');
}

module.exports = {
  MAX_INCIDENT_TOOLS,
  MAX_INCIDENT_PATHS,
  toolTraceDelta,
  createReviewerMutationIncident,
  formatReviewerMutationIncident,
};