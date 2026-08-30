'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readonlyFormatterMutation, readonlyShellMutation } = require('../src/copilot/session-factory');

test('read-only roles deny mutating formatter commands and allow check forms', () => {
  assert.equal(readonlyFormatterMutation('cargo fmt'), true);
  assert.equal(readonlyFormatterMutation('cargo fmt --all -- --check'), false);
  assert.equal(readonlyFormatterMutation('rustfmt src/lib.rs'), true);
  assert.equal(readonlyFormatterMutation('rustfmt --check src/lib.rs'), false);
  assert.equal(readonlyFormatterMutation('black .'), true);
  assert.equal(readonlyFormatterMutation('black --check .'), false);
  assert.equal(readonlyFormatterMutation('ruff format .'), true);
  assert.equal(readonlyFormatterMutation('ruff format --check .'), false);
  assert.equal(readonlyFormatterMutation('prettier --write src'), true);
  assert.equal(readonlyFormatterMutation('prettier --check src'), false);
  assert.equal(readonlyFormatterMutation('cargo test'), false);
});

test('shell mutation policy applies formatter detection to live reviewer hook arguments', () => {
  assert.equal(readonlyShellMutation({ toolName: 'builtin:bash', toolArgs: { command: 'cargo fmt' } }), true);
  assert.equal(readonlyShellMutation({ toolName: 'builtin:bash', toolArgs: { command: 'cargo fmt --all -- --check' } }), false);
  assert.equal(readonlyShellMutation({ toolName: 'builtin:powershell', toolArgs: { command: 'cargo test' } }), false);
});