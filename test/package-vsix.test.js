'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveVsixTarget,
  assertNoExplicitTarget,
  packageVsix,
} = require('../scripts/package-vsix');

test('VSIX packaging target follows the host platform and architecture', () => {
  assert.equal(resolveVsixTarget('win32', 'x64'), 'win32-x64');
  assert.equal(resolveVsixTarget('win32', 'arm64'), 'win32-arm64');
  assert.equal(resolveVsixTarget('linux', 'x64'), 'linux-x64');
  assert.equal(resolveVsixTarget('linux', 'arm64'), 'linux-arm64');
  assert.equal(resolveVsixTarget('darwin', 'x64'), 'darwin-x64');
  assert.equal(resolveVsixTarget('darwin', 'arm64'), 'darwin-arm64');
  assert.throws(() => resolveVsixTarget('freebsd', 'x64'), /Unsupported VSIX packaging host/);
});

test('package wrapper rejects an explicit target that could disagree with installed native dependencies', () => {
  assert.throws(() => assertNoExplicitTarget(['--target', 'win32-x64']), /Do not pass --target/);
  assert.throws(() => assertNoExplicitTarget(['--target=win32-x64']), /Do not pass --target/);
  assert.doesNotThrow(() => assertNoExplicitTarget(['--out', 'convergent.vsix']));
});

test('package wrapper invokes vsce with the detected target and forwarded arguments', () => {
  const calls = [];
  const target = packageVsix(['--out', '/tmp/convergent.vsix'], {
    platform: 'linux',
    arch: 'x64',
    root: '/repo',
    stdio: 'pipe',
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(target, 'linux-x64');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    '/repo/node_modules/@vscode/vsce/vsce',
    'package',
    '--target',
    'linux-x64',
    '--out',
    '/tmp/convergent.vsix',
  ]);
});

test('package wrapper propagates vsce failures', () => {
  assert.throws(
    () => packageVsix([], {
      platform: 'win32',
      arch: 'x64',
      root: 'C:\\repo',
      stdio: 'pipe',
      spawnSync() { return { status: 2 }; },
    }),
    (error) => error.code === 'CONVERGENT_VSCE_FAILED' && error.exitCode === 2,
  );
});
