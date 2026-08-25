'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { matchesDefect } = require('../src/headless/reviewer-v5-report');

test('V5 stale-lease matcher recognizes generation-capability findings without requiring the word stale', () => {
  assert.equal(matchesDefect('stale_lease_after_reclaim', {
    title: 'Lease validation does not enforce exact capability generation',
    description: 'A lease from generation 1 can complete generation 2 after expiry and reclaim by the same worker; arbitrary generation values are accepted.',
    file: 'taskflow/dispatch_service.py',
  }), true);
});

test('V5 stale-lease matcher does not confuse stale terminal queue entries with lease-generation defects', () => {
  assert.equal(matchesDefect('stale_lease_after_reclaim', {
    title: 'Claim can lease cancelled jobs from stale queue entries',
    description: 'A cancelled queue entry can be reclaimed and leased because claim does not check terminal status.',
    file: 'taskflow/dispatch_service.py',
  }), false);
});
