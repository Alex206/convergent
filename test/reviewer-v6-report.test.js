'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { matchesDefect } = require('../src/headless/reviewer-v6-report');

test('V6 matcher recognizes successful-validation negative-case false-positive findings', () => {
  assert.equal(matchesDefect('successful_validation_negative_case_false_positive', {
    title: 'Successful external validation is misclassified as blocked',
    description: 'The blocker classifier treats tested missing-token behavior as a current credential prerequisite even though the required validator passes, forcing CLEAN to BLOCKED.',
    file: 'src/orchestrator/report-blocker.js',
  }), true);
});

test('V6 matcher does not count a generic genuine validation failure', () => {
  assert.equal(matchesDefect('successful_validation_negative_case_false_positive', {
    title: 'External validator failure remains blocking',
    description: 'The required validator failed because a credential is missing.',
    file: 'src/orchestrator/report-blocker.js',
  }), false);
});
