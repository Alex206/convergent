'use strict';

const path = require('node:path');

const DEFAULT_TOOL_TIMEOUT_SECONDS = 300;
const MAX_TOOL_TIMEOUT_SECONDS = 3600;

function auditUi(ui, event) {
  try {
    if (typeof ui?.audit === 'function') void ui.audit(event);
    else void ui?.auditEvent?.(event);
  } catch {}
}

function clampTimeoutSeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TOOL_TIMEOUT_SECONDS;
  return Math.min(MAX_TOOL_TIMEOUT_SECONDS, Math.max(1, Math.trunc(parsed)));
}

function normalizeCwd(workspace, value) {
  if (value === undefined || value === null || value === '') return '.';
  const root = path.resolve(workspace);
  const candidate = path.resolve(root, String(value));
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`run_command cwd must stay inside the workspace: ${value}`);
  }
  return relative || '.';
}

function createRunCommandTool(defineTool, {
  runtime,
  workspace,
  owner,
  ui,
  permissionHandler,
  getGuard = () => null,
} = {}) {
  if (!runtime) throw new Error('createRunCommandTool requires a managed command runtime.');
  if (!workspace) throw new Error('createRunCommandTool requires a workspace.');

  return defineTool('run_command', {
    description: 'Run a managed workspace command under Convergent lifecycle control. Use this for tests, builds, long-running commands, or any command where exact completion/timeout/cancellation evidence matters. Convergent owns the PID/process tree, bounded output capture, timeout, and termination evidence.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute. Do not background the command; Convergent manages its lifecycle.',
        },
        cwd: {
          type: 'string',
          description: 'Optional workspace-relative working directory. It may not escape the workspace.',
        },
        timeoutSeconds: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_TOOL_TIMEOUT_SECONDS,
          description: 'Bounded command timeout in seconds. Defaults to 300 seconds.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args = {}) => {
      const command = String(args.command ?? '').trim();
      if (!command) return { accepted: false, error: 'run_command requires a non-empty command.' };
      let cwd;
      try {
        cwd = normalizeCwd(workspace, args.cwd);
      } catch (error) {
        return { accepted: false, error: error.message };
      }
      const timeoutSeconds = clampTimeoutSeconds(args.timeoutSeconds);
      if (typeof permissionHandler !== 'function') {
        return { accepted: false, error: 'run_command permission handler is unavailable; command was not started.' };
      }
      let permission;
      try {
        permission = await permissionHandler({
          kind: 'shell',
          fullCommandText: command,
          cwd: path.resolve(workspace, cwd),
          toolName: 'run_command',
        });
      } catch (error) {
        return { accepted: false, error: `run_command permission check failed: ${error.message ?? String(error)}` };
      }
      if (!String(permission?.kind ?? '').startsWith('approve')) {
        auditUi(ui, { type: 'managed_command_permission_denied', agent: owner, cwd, timeoutSeconds });
        return { accepted: false, error: 'run_command permission denied; command was not started.' };
      }
      const result = await runtime.execute(owner, {
        command,
        cwd,
        timeoutMs: timeoutSeconds * 1000,
        onStart: (info) => {
          getGuard()?.managedCommandProgress?.({
            commandId: info.commandId,
            pid: info.pid,
            phase: 'started',
          });
          auditUi(ui, {
            type: 'managed_command_start',
            agent: owner,
            commandId: info.commandId,
            pid: info.pid,
            cwd: info.cwd,
            timeoutSeconds,
          });
        },
        onOutput: (event) => {
          getGuard()?.managedCommandProgress?.({
            commandId: event.commandId,
            pid: event.pid,
            phase: 'output',
            stream: event.stream,
            bytes: event.bytes,
          });
          auditUi(ui, {
            type: 'managed_command_progress',
            agent: owner,
            commandId: event.commandId,
            pid: event.pid,
            stream: event.stream,
            bytes: event.bytes,
            elapsedMs: event.elapsedMs,
          });
        },
      });
      auditUi(ui, {
        type: 'managed_command_complete',
        agent: owner,
        commandId: result.commandId,
        pid: result.pid,
        state: result.state,
        exitCode: result.exitCode,
        signal: result.signal,
        elapsedMs: result.elapsedMs,
        stdoutBytes: Buffer.byteLength(result.stdout ?? ''),
        stderrBytes: Buffer.byteLength(result.stderr ?? ''),
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        termination: result.termination,
      });
      try {
        ui?.agentManagedCommandComplete?.(owner, {
          commandId: result.commandId,
          pid: result.pid,
          state: result.state,
          exitCode: result.exitCode,
          signal: result.signal,
          elapsedMs: result.elapsedMs,
          terminationProven: result.termination?.proven ?? null,
        });
      } catch {}
      return result;
    },
  });
}

module.exports = {
  createRunCommandTool,
  normalizeCwd,
  clampTimeoutSeconds,
  auditUi,
  DEFAULT_TOOL_TIMEOUT_SECONDS,
  MAX_TOOL_TIMEOUT_SECONDS,
};
