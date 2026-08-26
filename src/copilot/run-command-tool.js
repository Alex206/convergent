'use strict';

const path = require('node:path');
const { isSensitiveCredentialName } = require('./operator-credential-guard');
const { reviewerValidationPolicy } = require('./read-only-validation');
const { normalizeWorkspaceFolders, findWorkspaceFolder, rootForPath, qualifiedWorkspacePath } = require('../orchestrator/workspace-scope');

const DEFAULT_TOOL_TIMEOUT_SECONDS = 300;
const MAX_TOOL_TIMEOUT_SECONDS = 3600;

function auditUi(ui, event) {
  try {
    if (typeof ui?.audit === 'function') void ui.audit(event);
    else void ui?.auditEvent?.(event);
  } catch {}
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactSensitiveText(value, environment = process.env) {
  let text = String(value ?? '');
  if (!text) return text;

  const secretValues = Object.entries(environment ?? {})
    .filter(([name, secret]) => isSensitiveCredentialName(name) && String(secret ?? '').length >= 4)
    .map(([, secret]) => String(secret))
    .sort((a, b) => b.length - a.length);
  for (const secret of secretValues) {
    text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }

  text = text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/(Authorization\s*:\s*(?:Bearer|Basic)\s+)([^\s\"'`;]+)/gi, '$1[REDACTED]')
    .replace(/((?:--?(?:token|password|passwd|secret|api[-_]?key|access[-_]?token|client[-_]?secret))\s*(?:=|\s)\s*)(?:\"[^\"]*\"|'[^']*'|[^\s;]+)/gi, '$1[REDACTED]')
    .replace(/(\"(?:token|password|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\"\s*:\s*)\"(?:\\.|[^\"])*\"/gi, '$1\"[REDACTED]\"');
  return text;
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

function resolveRunCommandCwd(workspace, workspaceFolders, value, workspaceFolder) {
  const roots = normalizeWorkspaceFolders(workspace, workspaceFolders);
  const selected = findWorkspaceFolder(workspace, roots, workspaceFolder);
  if (!selected) throw new Error(`run_command workspaceFolder is not one of the opened workspace folders: ${workspaceFolder}`);
  const candidate = value === undefined || value === null || value === '' ? selected.path : path.isAbsolute(String(value)) ? path.resolve(String(value)) : path.resolve(selected.path, String(value));
  const owner = rootForPath(workspace, roots, candidate);
  if (!owner || owner.path !== selected.path) throw new Error(`run_command cwd must stay inside workspace folder ${selected.name}: ${value}`);
  const relative = path.relative(selected.path, candidate) || '.';
  return { root: selected, absolute: candidate, relative, display: qualifiedWorkspacePath(workspace, roots, selected, relative) };
}

function runCommandShellGuidance(platform = process.platform) {
  if (platform === 'win32') {
    return 'Commands run under Windows PowerShell (powershell.exe), not PowerShell 7 or cmd.exe. Do not use && or || command separators; use ; and explicitly gate dependent native commands with $LASTEXITCODE.';
  }
  return 'Commands run under POSIX sh syntax.';
}

function managedCommandHumanOutput(stdout, stderr, truncated = false) {
  const sections = [];
  if (stdout) sections.push(`[stdout]\n${stdout}`);
  if (stderr) sections.push(`[stderr]\n${stderr}`);
  if (truncated) sections.push('[managed command capture was truncated]');
  return sections.join('\n\n');
}

function createRunCommandTool(defineTool, {
  runtime,
  workspace,
  owner,
  ui,
  permissionHandler,
  getGuard = () => null,
  workspaceFolders = null,
} = {}) {
  if (!runtime) throw new Error('createRunCommandTool requires a managed command runtime.');
  if (!workspace) throw new Error('createRunCommandTool requires a workspace.');
  const shellGuidance = runCommandShellGuidance();

  return defineTool('run_command', {
    description: `Run a managed workspace command under Convergent lifecycle control. Use this for tests, builds, long-running commands, or any command where exact completion/timeout/cancellation evidence matters. Convergent owns the PID/process tree, bounded output capture, timeout, and termination evidence. ${shellGuidance}`,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: `Shell command to execute. Do not background the command; Convergent manages its lifecycle. ${shellGuidance}`,
        },
        workspaceFolder: { type: 'string', description: 'Optional exact opened VS Code workspace-folder name. Defaults to the primary folder.' },
        cwd: { type: 'string', description: 'Optional path relative to workspaceFolder, or an absolute path inside that same opened folder.' },
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
      const validationPolicy = reviewerValidationPolicy(owner, command);
      if (!validationPolicy.allowed) {
        auditUi(ui, {
          type: 'managed_command_readonly_validation_denied',
          agent: owner,
          reason: validationPolicy.reason,
        });
        return { accepted: false, error: validationPolicy.reason };
      }
      let cwdInfo;
      try {
        cwdInfo = resolveRunCommandCwd(workspace, workspaceFolders, args.cwd, args.workspaceFolder);
      } catch (error) {
        return { accepted: false, error: error.message };
      }
      const cwd = cwdInfo.display;
      const timeoutSeconds = clampTimeoutSeconds(args.timeoutSeconds);
      const displayCommand = redactSensitiveText(command);
      const shellLanguage = process.platform === 'win32' ? 'powershell' : 'sh';
      if (typeof permissionHandler !== 'function') {
        return { accepted: false, error: 'run_command permission handler is unavailable; command was not started.' };
      }
      let permission;
      try {
        permission = await permissionHandler({
          kind: 'shell',
          fullCommandText: command,
          cwd: cwdInfo.absolute,
          toolName: 'run_command',
        });
      } catch (error) {
        return { accepted: false, error: `run_command permission check failed: ${error.message ?? String(error)}` };
      }
      if (!String(permission?.kind ?? '').startsWith('approve')) {
        auditUi(ui, { type: 'managed_command_permission_denied', agent: owner, cwd, timeoutSeconds });
        return { accepted: false, error: 'run_command permission denied; command was not started.' };
      }
      const runtimeCwd = path.resolve(cwdInfo.root.path) === path.resolve(workspace) ? cwdInfo.relative : cwdInfo.absolute;
      const result = await runtime.execute(owner, {
        command,
        cwd: runtimeCwd,
        timeoutMs: timeoutSeconds * 1000,
        onStart: (info) => {
          getGuard()?.managedCommandProgress?.({
            commandId: info.commandId,
            pid: info.pid,
            phase: 'started',
            displayCommand,
            cwd,
            timeoutSeconds,
            shellLanguage,
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

      const redactedStdout = redactSensitiveText(result.stdout);
      const redactedStderr = redactSensitiveText(result.stderr);
      const capturedTruncated = Boolean(result.stdoutTruncated) || Boolean(result.stderrTruncated);
      const humanOutput = managedCommandHumanOutput(redactedStdout, redactedStderr, capturedTruncated);
      if (humanOutput && typeof ui?.log === 'function') {
        ui.log(`${owner} managed command ${result.commandId} captured output:\n${humanOutput}`);
      }

      try {
        ui?.agentManagedCommandComplete?.(owner, {
          commandId: result.commandId,
          pid: result.pid,
          state: result.state,
          exitCode: result.exitCode,
          signal: result.signal,
          elapsedMs: result.elapsedMs,
          terminationProven: result.termination?.proven ?? null,
          displayCommand,
          cwd,
          shellLanguage,
          // The model receives the original managed result below. Human-facing
          // Chat keeps only command/status metadata. Bounded/redacted stdout and
          // stderr live in the single Convergent Output log instead of creating
          // one extra "Show command output" button for every command.
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      } catch {}
      return result;
    },
  });
}

module.exports = {
  createRunCommandTool,
  normalizeCwd,
  resolveRunCommandCwd,
  clampTimeoutSeconds,
  redactSensitiveText,
  runCommandShellGuidance,
  managedCommandHumanOutput,
  auditUi,
  DEFAULT_TOOL_TIMEOUT_SECONDS,
  MAX_TOOL_TIMEOUT_SECONDS,
};
