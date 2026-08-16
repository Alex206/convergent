'use strict';

const RUNTIME_STALL_CODES = new Set([
  'CONVERGENT_TOOL_STALL',
  'CONVERGENT_AGENT_INACTIVITY',
]);
const RUNTIME_STALL_CHECKPOINT_STAGES = new Set([
  'worker_runtime_stall',
  'reviewer_runtime_stall',
]);

function boundedText(value, max = 500) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function pickTerminationEvidence(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    active: Boolean(value.active),
    proven: Boolean(value.proven),
    commandId: value.commandId ?? null,
    pid: Number.isInteger(value.pid) ? value.pid : null,
    method: value.method ?? null,
    reason: boundedText(value.reason, 240),
    requestedState: value.requestedState ?? null,
    rootGone: value.rootGone === undefined ? null : Boolean(value.rootGone),
    groupGone: value.groupGone === undefined ? null : Boolean(value.groupGone),
    termSent: value.termSent === undefined ? null : Boolean(value.termSent),
    killSent: value.killSent === undefined ? null : Boolean(value.killSent),
    taskkillExitCode: Number.isInteger(value.taskkillExitCode) ? value.taskkillExitCode : null,
  };
}

function runtimeStallIncident(error) {
  if (!error || !RUNTIME_STALL_CODES.has(error.code)) return null;
  const diagnostic = error.convergentDiagnostic && typeof error.convergentDiagnostic === 'object'
    ? error.convergentDiagnostic
    : {};
  const termination = pickTerminationEvidence(diagnostic.managedCommandTermination);
  const currentTool = diagnostic.currentTool && typeof diagnostic.currentTool === 'object'
    ? {
        id: diagnostic.currentTool.id ?? null,
        name: diagnostic.currentTool.name ?? null,
        durationMs: Number.isFinite(diagnostic.currentTool.durationMs) ? diagnostic.currentTool.durationMs : null,
        quietMs: Number.isFinite(diagnostic.currentTool.quietMs) ? diagnostic.currentTool.quietMs : null,
      }
    : null;

  return {
    code: error.code,
    message: boundedText(error.message, 500),
    currentTool,
    termination,
    recoverable: Boolean(termination?.active && termination?.proven),
  };
}

function runtimeStallRecoveryDetail(incident, workspaceFingerprint) {
  if (!incident) return null;
  const termination = incident.termination;
  const tool = incident.currentTool;
  const pieces = [
    `${incident.code}: ${incident.message}`,
    tool?.name ? `Stalled tool: ${tool.name}.` : '',
    termination?.commandId ? `Managed command id: ${termination.commandId}.` : '',
    termination?.pid ? `Managed root PID: ${termination.pid}.` : '',
    termination?.method ? `Termination method: ${termination.method}.` : '',
    termination ? `Termination proven: ${termination.proven ? 'yes' : 'no'}.` : 'No managed-command termination evidence was recorded.',
  ].filter(Boolean);
  return {
    changed: undefined,
    workspaceFingerprint,
    summary: pieces.join(' '),
    checks: termination?.proven
      ? ['Convergent terminated the managed command/process tree and obtained termination evidence before aborting the stalled Copilot turn.']
      : ['Convergent could not prove managed command/process-tree termination; automatic retry is unsafe.'],
    runtimeIncident: incident,
  };
}

function runtimeStallResumeDisposition(taskState) {
  if (!taskState || !RUNTIME_STALL_CHECKPOINT_STAGES.has(taskState.stage)) return null;
  const incident = taskState.runtimeIncident && typeof taskState.runtimeIncident === 'object'
    ? taskState.runtimeIncident
    : null;
  const termination = pickTerminationEvidence(incident?.termination);
  const safe = Boolean(termination?.active && termination?.proven);
  return {
    runtimeStall: true,
    safe,
    stage: taskState.stage,
    termination,
    reason: safe
      ? 'The managed command/process tree was proven terminated before the checkpoint; restarting the current task with a fresh session is safe.'
      : 'The checkpoint does not prove that the managed command/process tree terminated; /resume must not start another agent or command.',
  };
}

module.exports = {
  RUNTIME_STALL_CODES,
  RUNTIME_STALL_CHECKPOINT_STAGES,
  runtimeStallIncident,
  runtimeStallRecoveryDetail,
  runtimeStallResumeDisposition,
  pickTerminationEvidence,
};
