'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeExpectation,
  runRepeat,
  evaluateTopologyCompleteness,
  renderTopologyCompleteness,
} = require('../src/headless/topology-completeness');

test('topology completeness accepts the required distinct valid repeats for every arm', () => {
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
  assert.deepEqual(result.duplicateRepeats, []);
  assert.deepEqual(result.arms[0].repeats, [1, 2, 3]);
  assert.match(renderTopologyCompleteness(result), /distinct scored repeats/i);
});

test('topology completeness fails when an infrastructure-quarantined arm is absent from the scored report', () => {
  const report = {
    runs: Array.from({ length: 3 }, (_, repeat) => ({ topology: 'control', repeat: repeat + 1 })),
  };
  const result = evaluateTopologyCompleteness(report, ['control=3', 'candidate=3']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [{
    topology: 'candidate',
    expectedRuns: 3,
    actualRuns: 0,
    repeats: [],
  }]);
  assert.match(renderTopologyCompleteness(result), /comparison is \*\*incomplete\*\*/i);
});

test('topology completeness distinguishes partial samples from topology acceptance', () => {
  const report = {
    runs: [
      { topology: 'control', repeat: 1, accepted: false },
      { topology: 'control', repeat: 2, accepted: false },
      { topology: 'control', repeat: 3, accepted: false },
      { topology: 'candidate', repeat: 1, accepted: true },
      { topology: 'candidate', repeat: 2, accepted: false },
    ],
  };
  const result = evaluateTopologyCompleteness(report, [
    { topology: 'control', runs: 3 },
    { topology: 'candidate', runs: 3 },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [{
    topology: 'candidate',
    expectedRuns: 3,
    actualRuns: 2,
    repeats: [1, 2],
  }]);
});

test('duplicate scored artifacts cannot satisfy a missing distinct repeat', () => {
  const report = {
    runs: [
      { topology: 'candidate', repeat: 1 },
      { topology: 'candidate', repeat: 1 },
      { topology: 'candidate', repeat: 2 },
    ],
  };
  const result = evaluateTopologyCompleteness(report, ['candidate=3']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.arms[0].repeats, [1, 2]);
  assert.deepEqual(result.duplicateRepeats, [{ topology: 'candidate', repeat: 1 }]);
  assert.match(renderTopologyCompleteness(result), /candidate#1/);
});

test('topology expectation and repeat parsing fail closed', () => {
  assert.deepEqual(normalizeExpectation('typed-evidence=3'), { topology: 'typed-evidence', runs: 3 });
  assert.equal(runRepeat({ repeat: 3 }, 'typed-evidence'), 3);
  assert.throws(() => normalizeExpectation('typed-evidence'), /expected <topology>=<runs>/i);
  assert.throws(() => normalizeExpectation('typed-evidence=0'), /positive integer/i);
  assert.throws(() => runRepeat({ repeat: 0 }, 'typed-evidence'), /positive integer repeat id/i);
  assert.throws(
    () => evaluateTopologyCompleteness({ runs: [] }, ['typed-evidence=3', 'typed-evidence=3']),
    /unique topology names/i,
  );
});
