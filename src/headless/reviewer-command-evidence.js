'use strict';

const { workspaceRevision } = require('../orchestrator/revision');
const { redactSensitiveText } = require('../copilot/run-command-tool');

const MAX_CAPTURED_COMMAND_EVIDENCE = 8;
const MAX_AUDITOR_COMMAND_EVIDENCE = 4;
const MAX_COMMAND_CHARS = 4000;
const MAX_OUTPUT_CHARS = 12000;

function boundedText(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 32))}\n...[truncated ${text.length - limit} chars]`;
}

function parsedManagedResult(event) {
  const raw = event?.data?.result?.detailedContent ?? event?.data?.result?.content ?? '';
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : { output: String(raw) };
  } catch {
    return { output: String(raw) };
  }
}

function commandStartRecord(event) {
  const args = event?.data?.arguments ?? {};
  return {
    toolCallId: String(event?.data?.toolCallId ?? ''),
    command: boundedText(redactSensitiveText(args.command), MAX_COMMAND_CHARS),
    cwd: boundedText(args.cwd ?? '', 1000),
    workspaceFolder: boundedText(args.workspaceFolder ?? '', 500),
    timeoutSeconds: Number.isFinite(Number(args.timeoutSeconds)) ? Number(args.timeoutSeconds) : null,
  };
}

function commandCompletionRecord(start, event, revision) {
  const result = parsedManagedResult(event);
  return {
    revision: String(revision ?? ''),
    tool_call_id: start.toolCallId,
    command: start.command,
    cwd: start.cwd,
    workspace_folder: start.workspaceFolder,
    timeout_seconds: start.timeoutSeconds,
    tool_success: event?.data?.success === true,
    state: String(result.state ?? ''),
    exit_code: Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : null,
    signal: result.signal == null ? null : String(result.signal),
    error: boundedText(redactSensitiveText(result.error ?? ''), 2000),
    stdout: boundedText(redactSensitiveText(result.stdout ?? result.output ?? ''), MAX_OUTPUT_CHARS),
    stderr: boundedText(redactSensitiveText(result.stderr ?? ''), MAX_OUTPUT_CHARS),
    stdout_truncated: result.stdoutTruncated === true,
    stderr_truncated: result.stderrTruncated === true,
    elapsed_ms: Number.isFinite(Number(result.elapsedMs)) ? Number(result.elapsedMs) : null,
  };
}

function boundedPush(sink, value, limit = MAX_CAPTURED_COMMAND_EVIDENCE) {
  sink.push(value);
  if (sink.length > limit) sink.splice(0, sink.length - limit);
}

function captureReviewerCommandEvidence(session, {
  workspace,
  workspaceFolders = null,
  sink = [],
  revisionProvider = workspaceRevision,
} = {}) {
  if (!session?.on) throw new Error('captureReviewerCommandEvidence requires a session with event subscriptions.');
  if (!workspace) throw new Error('captureReviewerCommandEvidence requires workspace.');

  const pending = new Map();
  const completionPromises = [];
  const disposers = [];

  const startDispose = session.on('tool.execution_start', (event) => {
    if (String(event?.data?.toolName ?? '') !== 'run_command') return;
    const record = commandStartRecord(event);
    if (!record.toolCallId) return;
    pending.set(record.toolCallId, record);
  });
  if (startDispose) disposers.push(startDispose);

  const completeDispose = session.on('tool.execution_complete', (event) => {
    const toolCallId = String(event?.data?.toolCallId ?? '');
    const start = pending.get(toolCallId);
    if (!start) return;
    pending.delete(toolCallId);

    const completion = Promise.resolve()
      .then(() => revisionProvider(workspace, workspaceFolders))
      .then((revision) => {
        boundedPush(sink, commandCompletionRecord(start, event, revision));
      })
      .catch((error) => {
        boundedPush(sink, {
          revision: '',
          tool_call_id: start.toolCallId,
          command: start.command,
          cwd: start.cwd,
          workspace_folder: start.workspaceFolder,
          timeout_seconds: start.timeoutSeconds,
          capture_error: error?.message ?? String(error),
        });
      });
    completionPromises.push(completion);
  });
  if (completeDispose) disposers.push(completeDispose);

  return {
    sink,
    async flush() {
      await Promise.allSettled(completionPromises);
      return sink;
    },
    dispose() {
      for (const dispose of disposers) {
        try { dispose?.(); } catch {}
      }
    },
  };
}

function compactReviewerCommandEvidence(observations = [], revision, maxObservations = MAX_AUDITOR_COMMAND_EVIDENCE) {
  const expectedRevision = String(revision ?? '');
  return (Array.isArray(observations) ? observations : [])
    .filter((entry) => entry?.revision === expectedRevision && entry?.command)
    .slice(-Math.max(1, Number(maxObservations) || MAX_AUDITOR_COMMAND_EVIDENCE))
    .map((entry, index) => ({
      id: `command-${index + 1}`,
      command: entry.command,
      cwd: entry.cwd,
      workspace_folder: entry.workspace_folder,
      timeout_seconds: entry.timeout_seconds,
      tool_success: entry.tool_success,
      state: entry.state,
      exit_code: entry.exit_code,
      signal: entry.signal,
      error: entry.error,
      stdout: entry.stdout,
      stderr: entry.stderr,
      stdout_truncated: entry.stdout_truncated,
      stderr_truncated: entry.stderr_truncated,
      elapsed_ms: entry.elapsed_ms,
    }));
}

module.exports = {
  MAX_CAPTURED_COMMAND_EVIDENCE,
  MAX_AUDITOR_COMMAND_EVIDENCE,
  MAX_COMMAND_CHARS,
  MAX_OUTPUT_CHARS,
  boundedText,
  parsedManagedResult,
  commandStartRecord,
  commandCompletionRecord,
  boundedPush,
  captureReviewerCommandEvidence,
  compactReviewerCommandEvidence,
};
