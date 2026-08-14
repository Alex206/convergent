'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIntegritySink } = require('../src/headless/experimental-session-factory');

test('experimental report sink converts unsupported BLOCKED to CLEAN before recovery policy sees it', () => {
  const messages = [];
  const sink = createIntegritySink('Worker A', { log: (message) => messages.push(message) });
  sink.value = {
    verdict: 'blocked',
    summary: 'Implemented and exported the duration parser. No unresolved issues.',
    findings: [],
    checks: ['python -m unittest discover -s tests -v: 15 tests passed', 'git diff --check passed'],
  };
  assert.equal(sink.value.verdict, 'clean');
  assert.equal(sink.corrections.length, 1);
  assert.equal(messages.length, 1);
});

test('experimental report sink preserves genuine required-validation blocker', () => {
  const sink = createIntegritySink('Worker A');
  sink.value = {
    verdict: 'blocked',
    summary: 'Implementation is complete, but external validation is unavailable because TASKFLOW_RELEASE_TOKEN is not configured.',
    findings: [],
    checks: ['Unit tests passed', 'External validator exit 2: missing TASKFLOW_RELEASE_TOKEN'],
  };
  assert.equal(sink.value.verdict, 'blocked');
  assert.deepEqual(sink.corrections, []);
});

test('experimental reviewer sink can reconcile the same unsupported structured verdict shape', () => {
  const sink = createIntegritySink('Strong reviewer');
  sink.value = {
    verdict: 'blocked',
    summary: 'Current implementation satisfies all requirements. No actionable issues.',
    findings: [],
    checks: ['Independent focused tests passed'],
  };
  assert.equal(sink.value.verdict, 'clean');
});
