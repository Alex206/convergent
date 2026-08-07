'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isNodeExecutable,
  resolveRuntimeTransport,
  createClientOptions,
} = require('../src/copilot/runtime');

test('detects real Node executables', () => {
  assert.equal(isNodeExecutable('C:\\Program Files\\nodejs\\node.exe'), true);
  assert.equal(isNodeExecutable('/usr/bin/node'), true);
  assert.equal(isNodeExecutable('C:\\Program Files\\Microsoft VS Code\\Code.exe'), false);
});

test('auto uses stdio under a real Node process', () => {
  assert.equal(resolveRuntimeTransport('auto', 'C:\\Program Files\\nodejs\\node.exe'), 'stdio');
});

test('auto uses in-process transport inside the VS Code extension host', () => {
  assert.equal(resolveRuntimeTransport('auto', 'C:\\Program Files\\Microsoft VS Code\\Code.exe'), 'inprocess');
});

test('explicit transport overrides auto detection', () => {
  assert.equal(resolveRuntimeTransport('stdio', 'C:\\Program Files\\Microsoft VS Code\\Code.exe'), 'stdio');
  assert.equal(resolveRuntimeTransport('inprocess', 'C:\\Program Files\\nodejs\\node.exe'), 'inprocess');
});

test('in-process client options use RuntimeConnection.forInProcess', () => {
  const sentinel = { kind: 'inprocess-test' };
  const sdk = {
    RuntimeConnection: {
      forInProcess: () => sentinel,
    },
  };

  const result = createClientOptions(sdk, 'auto', 'C:\\Program Files\\Microsoft VS Code\\Code.exe');
  assert.equal(result.transport, 'inprocess');
  assert.equal(result.options.connection, sentinel);
});
