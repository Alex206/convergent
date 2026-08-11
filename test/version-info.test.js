'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runtimeVersionInfo } = require('../src/copilot/version-info');

test('runtime provenance identifies the installed Copilot SDK CLI and host package', () => {
  const info = runtimeVersionInfo();
  assert.equal(info.sdk.name, '@github/copilot-sdk');
  assert.equal(info.sdk.version, '1.0.8');
  assert.equal(info.cli.name, '@github/copilot');
  assert.ok(info.cli.version, 'transitive @github/copilot CLI/runtime version must be discoverable');
  assert.equal(info.platform, process.platform);
  assert.equal(info.arch, process.arch);
  assert.ok(info.node.startsWith('v'));
  assert.equal(info.platformPackages.length, 1, 'a clean npm ci should install exactly one host-specific Copilot runtime package');
  assert.ok(info.platformPackages[0].name.startsWith('@github/copilot-'));
  assert.ok(info.platformPackages[0].version);
});
