'use strict';

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''));
}

function commandResultMetadata(result) {
  if (!result) return null;
  return Object.freeze({
    commandId: result.commandId ?? null,
    pid: result.pid ?? null,
    state: result.state ?? null,
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    elapsedMs: Number.isFinite(result.elapsedMs) ? result.elapsedMs : null,
    stdoutBytes: byteLength(result.stdout),
    stderrBytes: byteLength(result.stderr),
    stdoutTruncated: Boolean(result.stdoutTruncated),
    stderrTruncated: Boolean(result.stderrTruncated),
    termination: result.termination ? Object.freeze({
      method: result.termination.method ?? null,
      proven: result.termination.proven === true,
      requestedState: result.termination.requestedState ?? null,
      rootGone: result.termination.rootGone ?? null,
      groupGone: result.termination.groupGone ?? null,
      termSent: result.termination.termSent ?? null,
      killSent: result.termination.killSent ?? null,
      taskkillExitCode: result.termination.taskkillExitCode ?? null,
    }) : null,
    startErrorPresent: Boolean(result.error),
  });
}

function validationGateAuditRecord(evidence = {}) {
  return Object.freeze({
    type: 'validation_gate_result',
    gateId: evidence.gateId ?? null,
    validatorId: evidence.validatorId ?? null,
    policy: evidence.policy ?? null,
    workspaceFolder: evidence.workspaceFolder ?? null,
    cwd: evidence.cwd ?? null,
    outcome: evidence.outcome ?? null,
    blocksAcceptance: Boolean(evidence.blocksAcceptance),
    revisionStable: evidence.revisionStable ?? null,
    expectedRevision: evidence.expectedRevision ?? null,
    candidateRevisionMatched: evidence.candidateRevisionMatched ?? null,
    beforeRevision: evidence.beforeRevision ?? null,
    afterRevision: evidence.afterRevision ?? null,
    skippedForPlatform: evidence.skippedForPlatform ?? null,
    notRunReason: evidence.notRunReason ?? null,
    executionErrorPresent: Boolean(evidence.executionError),
    command: commandResultMetadata(evidence.commandResult),
  });
}

function validationGateSetAuditRecord(summary = {}) {
  const evidences = Array.isArray(summary.evidences) ? summary.evidences : [];
  const outcomeCounts = {};
  for (const evidence of evidences) {
    const outcome = String(evidence?.outcome ?? 'unknown');
    outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
  }
  return Object.freeze({
    type: 'validation_gate_set_result',
    candidateRevision: summary.candidateRevision ?? null,
    currentRevision: summary.currentRevision ?? null,
    accepted: Boolean(summary.accepted),
    blocksAcceptance: Boolean(summary.blocksAcceptance),
    completedAllApplicable: Boolean(summary.completedAllApplicable),
    requiredApplicable: Number(summary.requiredApplicable ?? 0),
    requiredPassed: Number(summary.requiredPassed ?? 0),
    revisionErrorPresent: Boolean(summary.revisionError),
    gateCount: evidences.length,
    outcomeCounts: Object.freeze(outcomeCounts),
  });
}

module.exports = {
  byteLength,
  commandResultMetadata,
  validationGateAuditRecord,
  validationGateSetAuditRecord,
};
