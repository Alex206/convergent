#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TARGETS = new Map([
  ['win32:x64', 'win32-x64'],
  ['win32:arm64', 'win32-arm64'],
  ['linux:x64:glibc', 'linux-x64'],
  ['linux:arm64:glibc', 'linux-arm64'],
  ['linux:x64:musl', 'alpine-x64'],
  ['linux:arm64:musl', 'alpine-arm64'],
  ['darwin:x64', 'darwin-x64'],
  ['darwin:arm64', 'darwin-arm64'],
]);

function detectLinuxLibc(report = process.report) {
  if (!report || typeof report.getReport !== 'function') {
    throw new Error('Cannot detect Linux libc: process.report.getReport() is unavailable.');
  }
  const header = report.getReport()?.header;
  if (!header || typeof header !== 'object') {
    throw new Error('Cannot detect Linux libc: Node process report has no header.');
  }
  return header.glibcVersionRuntime ? 'glibc' : 'musl';
}

function resolveVsixTarget(platform = process.platform, arch = process.arch, libc = null) {
  const key = platform === 'linux'
    ? `${platform}:${arch}:${libc ?? detectLinuxLibc()}`
    : `${platform}:${arch}`;
  const target = TARGETS.get(key);
  if (!target) {
    const detail = platform === 'linux' ? `${platform}/${arch}/${libc ?? 'detected-libc'}` : `${platform}/${arch}`;
    throw new Error(
      `Unsupported VSIX packaging host ${detail}. `
      + 'Package Convergent on a host that matches a supported VS Code target instead of producing a generic VSIX with the wrong native Copilot runtime.',
    );
  }
  return target;
}

function assertNoExplicitTarget(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--target' || arg.startsWith('--target=')) {
      throw new Error(
        'Do not pass --target to npm run package. Convergent derives the VSIX target from the packaging host so native Copilot dependencies and VSIX metadata cannot disagree.',
      );
    }
  }
}

function packageVsix(args = process.argv.slice(2), options = {}) {
  assertNoExplicitTarget(args);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const libc = platform === 'linux'
    ? (options.libc ?? detectLinuxLibc(options.processReport ?? process.report))
    : null;
  const target = resolveVsixTarget(platform, arch, libc);
  const root = options.root ?? path.resolve(__dirname, '..');
  const vsceCli = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
  const spawn = options.spawnSync ?? spawnSync;
  const child = spawn(
    process.execPath,
    [vsceCli, 'package', '--target', target, ...args],
    { cwd: root, stdio: options.stdio ?? 'inherit' },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    const error = new Error(`vsce package failed for ${target} with exit code ${child.status}.`);
    error.code = 'CONVERGENT_VSCE_FAILED';
    error.exitCode = child.status;
    throw error;
  }
  return target;
}

function main() {
  const target = packageVsix();
  console.log(`Convergent VSIX target: ${target}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  TARGETS,
  detectLinuxLibc,
  resolveVsixTarget,
  assertNoExplicitTarget,
  packageVsix,
};
