'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  VALIDATION_GATE_CONFIG_RELATIVE_PATH,
  parseValidationGateConfig,
  loadRepositoryValidationGates,
} = require('../src/orchestrator/validation-gate-config');

function tempDir(t, prefix = 'convergent-validation-config-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeConfig(root, value) {
  const file = path.join(root, VALIDATION_GATE_CONFIG_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

test('repository config is versioned, strict, and scopes gates to its own workspace folder', () => {
  const parsed = parseValidationGateConfig(JSON.stringify({
    version: 1,
    gates: [
      { id: 'unit', command: 'npm test', policy: 'required', timeoutMs: 30_000 },
      { id: 'lint', command: 'npm run lint', policy: 'advisory', platforms: ['linux', 'win32'] },
    ],
  }), { workspaceFolder: 'repo-a', source: 'repo-a/.convergent/validation-gates.json' });

  assert.equal(parsed.version, 1);
  assert.equal(parsed.gates.length, 2);
  assert.equal(parsed.gates[0].workspaceFolder, 'repo-a');
  assert.equal(parsed.gates[1].workspaceFolder, 'repo-a');
  assert.notEqual(parsed.gates[0].validatorId, parsed.gates[1].validatorId);
});

test('repository config rejects unknown fields, cross-root targeting, duplicates, and unsupported versions', () => {
  assert.throws(() => parseValidationGateConfig(JSON.stringify({ version: 2, gates: [] }), { workspaceFolder: 'repo' }), /version must be 1/);
  assert.throws(() => parseValidationGateConfig(JSON.stringify({ version: 1, gates: [], extra: true }), { workspaceFolder: 'repo' }), /unsupported key: extra/);
  assert.throws(() => parseValidationGateConfig(JSON.stringify({
    version: 1,
    gates: [{ id: 'unit', command: 'npm test', workspaceFolder: 'other' }],
  }), { workspaceFolder: 'repo' }), /unsupported key: workspaceFolder/);
  assert.throws(() => parseValidationGateConfig(JSON.stringify({
    version: 1,
    gates: [{ id: 'unit', command: 'npm test' }, { id: 'UNIT', command: 'npm run other' }],
  }), { workspaceFolder: 'repo' }), /duplicate gate id "unit"/);
});

test('missing repository configs are a no-op and no standard project script is inferred', async (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));

  const loaded = await loadRepositoryValidationGates(root, [{ name: 'repo', path: root }]);
  assert.equal(loaded.configs.length, 1);
  assert.equal(loaded.configs[0].present, false);
  assert.deepEqual(loaded.gates, []);
});

test('multi-root loader keeps each repository authoritative only for its own gates', async (t) => {
  const container = tempDir(t, 'convergent-validation-multiconfig-');
  const left = path.join(container, 'left');
  const right = path.join(container, 'right');
  fs.mkdirSync(left);
  fs.mkdirSync(right);
  writeConfig(left, { version: 1, gates: [{ id: 'test', command: 'npm test' }] });
  writeConfig(right, { version: 1, gates: [{ id: 'test', command: 'python -m pytest' }] });

  const loaded = await loadRepositoryValidationGates(left, [
    { name: 'left', path: left },
    { name: 'right', path: right },
  ]);

  assert.equal(loaded.configs.length, 2);
  assert.equal(loaded.gates.length, 2);
  assert.equal(loaded.gates[0].workspaceFolder, 'left');
  assert.equal(loaded.gates[1].workspaceFolder, 'right');
  assert.equal(loaded.gates[0].id, 'test');
  assert.equal(loaded.gates[1].id, 'test');
  assert.notEqual(loaded.gates[0].validatorId, loaded.gates[1].validatorId);
});

test('repository config file itself must be a regular in-root file', async (t) => {
  const root = tempDir(t);
  const configPath = path.join(root, VALIDATION_GATE_CONFIG_RELATIVE_PATH);
  fs.mkdirSync(configPath, { recursive: true });

  await assert.rejects(
    loadRepositoryValidationGates(root, [{ name: 'repo', path: root }]),
    /config path must be a regular file/,
  );
});

test('symbolic-link config is rejected where file symlinks are supported', { skip: process.platform === 'win32' }, async (t) => {
  const root = tempDir(t);
  const outside = path.join(tempDir(t, 'convergent-validation-outside-'), 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ version: 1, gates: [] }));
  const configPath = path.join(root, VALIDATION_GATE_CONFIG_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.symlinkSync(outside, configPath);

  await assert.rejects(
    loadRepositoryValidationGates(root, [{ name: 'repo', path: root }]),
    /config file must not be a symbolic link/,
  );
});
