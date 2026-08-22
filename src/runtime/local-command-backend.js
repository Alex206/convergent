'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { normalizeWorkspaceFolders, rootForPath } = require('../orchestrator/workspace-scope');

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_CAPTURE_BYTES = 256 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const TERMINATION_CONFIRM_TIMEOUT_MS = 5_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandId() {
  return `cmd-${crypto.randomUUID()}`;
}

function clampPositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function appendBounded(current, chunk, maxBytes) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  if (next.length <= maxBytes) return { buffer: next, truncated: false };
  return { buffer: next.subarray(next.length - maxBytes), truncated: true };
}

function normalizeWorkspace(workspace) {
  if (!workspace) throw new Error('Managed command runtime requires a workspace directory.');
  return path.resolve(workspace);
}

function resolveWorkingDirectory(workspace, value, workspaceFolders = null) {
  const root = normalizeWorkspace(workspace); const roots = normalizeWorkspaceFolders(root, workspaceFolders);
  if (value === undefined || value === null || value === '') return root;
  const candidate = path.isAbsolute(String(value)) ? path.resolve(String(value)) : path.resolve(root, String(value));
  if (!rootForPath(root, roots, candidate)) throw new Error(`Managed command cwd must stay inside the workspace or another opened workspace folder: ${value}`);
  return candidate;
}

function shellInvocation(command, platform = process.platform) {
  if (platform === 'win32') {
    // Convergent's VS Code/Windows users naturally author PowerShell commands.
    // Use Windows PowerShell explicitly so pipelines, ';', variables, and
    // quoting have the same semantics as the built-in PowerShell tool.
    // PowerShell treats a leading quoted executable path as a string unless
    // the call operator is present, so normalize only that cmd-compatible edge.
    const powershellCommand = /^"[^"]+"\s/.test(command) ? `& ${command}` : command;
    // powershell.exe itself does not automatically propagate a native child's
    // exit code. Capture the final operation immediately after the user's
    // command so run_command retains the exact lifecycle status expected from
    // a shell command. Pure PowerShell success/failure remains 0/1.
    const wrappedCommand = [
      '$global:LASTEXITCODE = $null',
      powershellCommand,
      '$__convergent_ok = $?',
      '$__convergent_last_exit = $LASTEXITCODE',
      'if ($__convergent_ok) { exit 0 }',
      'if ($null -ne $__convergent_last_exit -and $__convergent_last_exit -ne 0) { exit $__convergent_last_exit }',
      'exit 1',
    ].join('\n');
    return {
      file: process.env.CONVERGENT_POWERSHELL || 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrappedCommand],
      windowsVerbatimArguments: false,
    };
  }
  return {
    file: process.env.SHELL || '/bin/sh',
    args: ['-lc', command],
    windowsVerbatimArguments: false,
  };
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function processGroupExists(pid) {
  if (process.platform === 'win32') return processExists(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitUntilGone(check, timeoutMs = TERMINATION_CONFIRM_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!check()) return true;
    await delay(50);
  }
  return !check();
}

function spawnAndCollect(file, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: null, signal: null, stdout, stderr, error: error.message });
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal, stdout, stderr, error: null });
    });
  });
}

class LocalCommandBackend {
  constructor({ workspace, workspaceFolders = null, maxCaptureBytes = DEFAULT_MAX_CAPTURE_BYTES, terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS } = {}) {
    this.workspace = normalizeWorkspace(workspace);
    this.workspaceFolders = normalizeWorkspaceFolders(this.workspace, workspaceFolders);
    this.maxCaptureBytes = clampPositiveInteger(maxCaptureBytes, DEFAULT_MAX_CAPTURE_BYTES, 1024, 16 * 1024 * 1024);
    this.terminationGraceMs = clampPositiveInteger(terminationGraceMs, DEFAULT_TERMINATION_GRACE_MS, 50, 10_000);
    this.active = new Map();
  }

  async run(options = {}) {
    const command = String(options.command ?? '').trim();
    if (!command) throw new Error('Managed command requires a non-empty command string.');

    const cwd = resolveWorkingDirectory(this.workspace, options.cwd, this.workspaceFolders);
    const timeoutMs = clampPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 24 * 60 * 60_000);
    const maxCaptureBytes = clampPositiveInteger(options.maxCaptureBytes, this.maxCaptureBytes, 1024, 16 * 1024 * 1024);
    const id = commandId();
    const startedAt = Date.now();
    const invocation = shellInvocation(command);

    const record = {
      id,
      command,
      cwd,
      pid: null,
      child: null,
      startedAt,
      completedAt: null,
      state: 'starting',
      requestedTerminalState: null,
      terminationReason: null,
      termination: null,
      terminationPromise: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutTruncated: false,
      stderrTruncated: false,
      lastOutputAt: startedAt,
      settled: false,
    };
    this.active.set(id, record);

    return new Promise((resolve) => {
      let timeout;
      const finish = async (exitCode, signal, startError = null) => {
        if (record.settled) return;
        record.settled = true;
        if (timeout) clearTimeout(timeout);
        if (record.terminationPromise) {
          try { await record.terminationPromise; } catch {}
        }
        record.completedAt = Date.now();
        if (startError) record.state = 'failed_to_start';
        else if (record.requestedTerminalState) record.state = record.requestedTerminalState;
        else record.state = 'completed';
        this.active.delete(id);
        resolve(this.snapshot(record, { exitCode, signal, error: startError?.message ?? null }));
      };

      let child;
      try {
        child = spawn(invocation.file, invocation.args, {
          cwd,
          env: process.env,
          windowsHide: true,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        void finish(null, null, error);
        return;
      }

      record.child = child;
      record.pid = child.pid ?? null;
      record.state = 'running';
      options.onStart?.({ commandId: id, pid: record.pid, cwd, startedAt });

      const output = (stream, chunk) => {
        const key = stream === 'stderr' ? 'stderr' : 'stdout';
        const truncatedKey = `${key}Truncated`;
        const bounded = appendBounded(record[key], chunk, maxCaptureBytes);
        record[key] = bounded.buffer;
        record[truncatedKey] = record[truncatedKey] || bounded.truncated;
        record.lastOutputAt = Date.now();
        options.onOutput?.({
          commandId: id,
          pid: record.pid,
          stream: key,
          chunk: chunk.toString(),
          bytes: Buffer.byteLength(chunk),
          elapsedMs: record.lastOutputAt - startedAt,
        });
      };
      child.stdout?.on('data', (chunk) => output('stdout', chunk));
      child.stderr?.on('data', (chunk) => output('stderr', chunk));
      child.once('error', (error) => { void finish(null, null, error); });
      child.once('close', (exitCode, signal) => { void finish(exitCode, signal); });

      timeout = setTimeout(() => {
        void this.cancel(id, { terminalState: 'timed_out', reason: `timeout after ${timeoutMs}ms` });
      }, timeoutMs);
      timeout.unref?.();
    });
  }

  async cancel(id, { terminalState = 'cancelled', reason = 'cancel requested' } = {}) {
    const record = this.active.get(id);
    if (!record) return { commandId: id, active: false, proven: true, reason: 'not-active' };
    if (record.terminationPromise) return record.terminationPromise;
    record.requestedTerminalState = terminalState;
    record.terminationReason = reason;
    record.terminationPromise = this.terminateRecord(record);
    record.termination = await record.terminationPromise;
    return record.termination;
  }

  async terminateRecord(record) {
    const pid = record.pid;
    if (!pid) {
      return { commandId: record.id, pid: null, method: 'none', proven: true, reason: 'process-not-started' };
    }

    if (process.platform === 'win32') {
      const taskkill = await spawnAndCollect('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
      const rootGone = await waitUntilGone(() => processExists(pid));
      return {
        commandId: record.id,
        pid,
        method: 'taskkill-tree',
        requestedState: record.requestedTerminalState,
        reason: record.terminationReason,
        taskkillExitCode: taskkill.exitCode,
        taskkillSignal: taskkill.signal,
        taskkillError: taskkill.error,
        rootGone,
        proven: rootGone && (taskkill.exitCode === 0 || !processExists(pid)),
      };
    }

    let termSent = false;
    let killSent = false;
    try {
      process.kill(-pid, 'SIGTERM');
      termSent = true;
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }

    let groupGone = await waitUntilGone(() => processGroupExists(pid), this.terminationGraceMs);
    if (!groupGone) {
      try {
        process.kill(-pid, 'SIGKILL');
        killSent = true;
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
      groupGone = await waitUntilGone(() => processGroupExists(pid));
    }

    return {
      commandId: record.id,
      pid,
      processGroupId: pid,
      method: 'posix-process-group',
      requestedState: record.requestedTerminalState,
      reason: record.terminationReason,
      termSent,
      killSent,
      groupGone,
      proven: groupGone,
    };
  }

  snapshot(record, { exitCode = null, signal = null, error = null } = {}) {
    const completedAt = record.completedAt ?? Date.now();
    return {
      commandId: record.id,
      pid: record.pid,
      state: record.state,
      exitCode,
      signal,
      error,
      cwd: record.cwd,
      startedAt: new Date(record.startedAt).toISOString(),
      completedAt: record.completedAt ? new Date(record.completedAt).toISOString() : null,
      elapsedMs: completedAt - record.startedAt,
      lastOutputAgoMs: Math.max(0, completedAt - record.lastOutputAt),
      stdout: record.stdout.toString(),
      stderr: record.stderr.toString(),
      stdoutTruncated: record.stdoutTruncated,
      stderrTruncated: record.stderrTruncated,
      termination: record.termination,
    };
  }
}

class ManagedCommandRuntime {
  constructor(options = {}) {
    this.backend = options.backend ?? new LocalCommandBackend(options);
    this.activeByOwner = new Map();
  }

  async execute(owner, options = {}) {
    const ownerKey = String(owner ?? 'agent');
    if (this.activeByOwner.has(ownerKey)) {
      throw new Error(`${ownerKey} already has an active managed command.`);
    }
    let id = null;
    try {
      return await this.backend.run({
        ...options,
        onStart: (info) => {
          id = info.commandId;
          this.activeByOwner.set(ownerKey, id);
          options.onStart?.(info);
        },
      });
    } finally {
      if (id && this.activeByOwner.get(ownerKey) === id) this.activeByOwner.delete(ownerKey);
    }
  }

  async cancelOwner(owner, reason = 'owner cancellation requested') {
    const ownerKey = String(owner ?? 'agent');
    const id = this.activeByOwner.get(ownerKey);
    if (!id) return { owner: ownerKey, active: false, proven: true, reason: 'no-managed-command' };
    const termination = await this.backend.cancel(id, { terminalState: 'cancelled', reason });
    return { owner: ownerKey, active: true, ...termination };
  }
}

module.exports = {
  LocalCommandBackend,
  ManagedCommandRuntime,
  resolveWorkingDirectory,
  shellInvocation,
  processExists,
  processGroupExists,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CAPTURE_BYTES,
  DEFAULT_TERMINATION_GRACE_MS,
};
