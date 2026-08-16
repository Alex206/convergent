'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalCommandBackend, ManagedCommandRuntime, processExists } = require('../src/runtime/local-command-backend');

function quote(value) {
  const text = String(value);
  if (process.platform === 'win32') return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function nodeCommand(scriptPath, ...args) {
  return [quote(process.execPath), quote(scriptPath), ...args.map(quote)].join(' ');
}

function makeWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convergent-command-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

test('managed command returns exact exit state and bounded stdout/stderr', async (t) => {
  const workspace = makeWorkspace(t);
  const script = path.join(workspace, 'exit.js');
  fs.writeFileSync(script, "process.stdout.write('hello\\n'); process.stderr.write('warn\\n'); process.exit(7);\n");
  const backend = new LocalCommandBackend({ workspace });

  const result = await backend.run({ command: nodeCommand(script), timeoutMs: 5_000 });

  assert.equal(result.state, 'completed');
  assert.equal(result.exitCode, 7);
  assert.match(result.stdout, /hello/);
  assert.match(result.stderr, /warn/);
  assert.equal(result.termination, null);
  assert.ok(result.commandId.startsWith('cmd-'));
  assert.ok(Number.isInteger(result.pid));
});

test('managed command rejects cwd escape outside workspace', async (t) => {
  const workspace = makeWorkspace(t);
  const backend = new LocalCommandBackend({ workspace });
  await assert.rejects(
    backend.run({ command: 'echo no', cwd: '..' }),
    /cwd must stay inside the workspace/,
  );
});

test('managed command bounds captured output while preserving the tail', async (t) => {
  const workspace = makeWorkspace(t);
  const script = path.join(workspace, 'output.js');
  fs.writeFileSync(script, "process.stdout.write('A'.repeat(5000) + 'TAIL');\n");
  const backend = new LocalCommandBackend({ workspace, maxCaptureBytes: 1024 });

  const result = await backend.run({ command: nodeCommand(script), timeoutMs: 5_000 });

  assert.equal(result.state, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 1024);
  assert.match(result.stdout, /TAIL$/);
});

test('timeout terminates the managed process tree and records proof', async (t) => {
  const workspace = makeWorkspace(t);
  const pidFile = path.join(workspace, 'child.pid');
  const script = path.join(workspace, 'hang-tree.js');
  fs.writeFileSync(script, [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "fs.writeFileSync(process.argv[2], String(child.pid));",
    "setInterval(() => {}, 1000);",
    '',
  ].join('\n'));
  const backend = new LocalCommandBackend({ workspace, terminationGraceMs: 200 });

  const result = await backend.run({ command: nodeCommand(script, pidFile), timeoutMs: 600 });

  assert.equal(result.state, 'timed_out');
  assert.ok(result.termination, 'timeout must include termination evidence');
  assert.equal(result.termination.proven, true);
  assert.equal(processExists(result.pid), false, 'managed shell/root process must be gone');
  assert.equal(fs.existsSync(pidFile), true, 'fixture must have created the descendant pid file');
  const descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(await waitFor(() => !processExists(descendantPid)), true, `descendant ${descendantPid} must not leak after timeout`);
});

test('runtime cancellation terminates an active owner command before returning proof', async (t) => {
  const workspace = makeWorkspace(t);
  const script = path.join(workspace, 'hang.js');
  fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");
  const runtime = new ManagedCommandRuntime({ workspace, terminationGraceMs: 200 });
  let started;
  const start = new Promise((resolve) => { started = resolve; });

  const execution = runtime.execute('Worker A', {
    command: nodeCommand(script),
    timeoutMs: 30_000,
    onStart: started,
  });
  const info = await start;
  const termination = await runtime.cancelOwner('Worker A', 'test cancellation');
  const result = await execution;

  assert.equal(termination.active, true);
  assert.equal(termination.proven, true);
  assert.equal(result.commandId, info.commandId);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.termination?.proven, true);
  assert.equal(processExists(info.pid), false);
});
