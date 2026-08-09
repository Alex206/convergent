'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ConvergentEngine,
  formatInspectionHints,
  formatPeerPass,
} = require('../src/orchestrator/engine');

function fakeUi() {
  return new Proxy({}, { get: () => () => {} });
}

const task = {
  id: 't1',
  title: 'Test task',
  description: 'Implement something',
  acceptanceCriteria: ['It works'],
  inspectionHints: ['src/a.js', 'src/b.js'],
};

test('coordinator inspection hints are handed to Worker A as bounded non-authoritative starting context', () => {
  const text = formatInspectionHints(task);
  assert.match(text, /src\/a\.js/);
  assert.match(text, /src\/b\.js/);
  assert.match(text, /non-authoritative/i);
  assert.match(text, /instead of rediscovering/i);
});

test('peer handoff carries the deterministic task change manifest', () => {
  const text = formatPeerPass({
    worker: 'A',
    changed: true,
    revision: 'R2',
    report: { verdict: 'changed', summary: 'Implemented', findings: [], checks: [] },
    changeManifest: {
      count: 2,
      entries: [
        { path: 'taskflow/config.py', status: ' M', kind: 'changed_since_task_start' },
        { path: 'tests/test_config.py', status: ' M', kind: 'changed_since_task_start' },
      ],
    },
  });
  assert.match(text, /Deterministic task change manifest after the peer pass/);
  assert.match(text, /taskflow\/config\.py/);
  assert.match(text, /tests\/test_config\.py/);
});

test('Fast Worker B is explicitly required to inspect the actual changed implementation, not only grep and tests', async () => {
  let prompt = '';
  const revision = { value: 'R2' };
  const sink = { value: null };
  const worker = {
    name: 'B',
    sink,
    session: {
      async sendAndWait(options) {
        prompt = options.prompt;
        sink.value = { verdict: 'clean', summary: 'reviewed', findings: [], checks: [] };
      },
      async disconnect() {},
    },
  };
  const engine = new ConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: fakeUi(),
    revisionProvider: async () => revision.value,
  });
  const peerPass = {
    worker: 'A',
    changed: true,
    revision: 'R2',
    report: { verdict: 'changed', summary: 'implemented', findings: [], checks: ['tests passed'] },
    changeManifest: {
      count: 1,
      entries: [{ path: 'src/a.js', status: ' M', kind: 'changed_since_task_start' }],
    },
  };

  await engine.runWorkerPass(worker, task, 'REVIEW_AND_FIX', null, peerPass, {
    flowMode: 'fast',
    baselineChangeState: null,
  });

  assert.match(prompt, /inspect the actual diff\/current implementation/i);
  assert.match(prompt, /grep plus rerunning tests alone is not an adversarial review/i);
  assert.match(prompt, /src\/a\.js/);
});
