'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeExpectation,
  evaluateTopologyCompleteness,
  renderTopologyCompleteness,
} = require('../src/headless/topology-completeness');

test('topology completeness accepts the required valid sample count for every arm', () => {
  const report = {
    runs: [
      ...Array.from({ length: 3 }, (_, repeat) => ({ topology: 'control', repeat: repeat + 1 })),
      ...Array.from({ length: 3 }, (_, repeat) => ({ topology: 'candidate', repeat: repeat + 1 })),
    ],
  };
  const result = evaluateTopologyCompleteness(report, ['control=3', 'candidate=3']);
  assert.equal(result.ok, true);
  assert.equal(result.scoredRuns, 6);
  assert.deepEqual(result.missing, []);
  assert.match(renderTopologyCompleteness(result), /All expected topology samples are present/i);
});

test('topology completeness fails when an infrastructure-quarantined arm is absent from the scored report', () => {
  const report = {
    runs: Array.from({ length: 3 }, (_, repeat) => ({ topology: 'control', repeat: repeat + 1 })),
  };
  const result = evaluateTopologyCompleteness(report, ['control=3', 'candidate=3']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [{ topology: 'candidate', expectedRuns: 3, actualRuns: 0 }]);
  assert.match(renderTopologyCompleteness(result), /comparison is \*\*incomplete\*\*/i);
});

test('topology completeness distinguishes partial samples from topology acceptance', () => {
  const report = {
    runs: [
      { topology: 'control', accepted: false },
      { topology: 'control', accepted: false },
      { topology: 'control', accepted: false },
      { topology: 'candidate', accepted: true },
      { topology: 'candidate', accepted: false },
    ],
  };
  const result = evaluateTopologyCompleteness(report, [
    { topology: 'control', runs: 3 },
    { topology: 'candidate', runs: 3 },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [{ topology: 'candidate', expectedRuns: 3, actualRuns: 2 }]);
});

test('topology expectation parsing is strict and duplicate topology expectations fail closed', () => {
  assert.deepEqual(normalizeExpectation('typed-evidence=3'), { topology: 'typed-evidence', runs: 3 });
  assert.throws(() => normalizeExpectation('typed-evidence'), /expected <topology>=<runs>/i);
  assert.throws(() => normalizeExpectation('typed-evidence=0'), /positive integer/i);
  assert.throws(
    () => evaluateTopologyCompleteness({ runs: [] }, ['typed-evidence=3', 'typed-evidence=3']),
    /unique topology names/i,
  );
});
