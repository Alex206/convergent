'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toolTraceDelta, createReviewerMutationIncident } = require('../src/orchestrator/reviewer-integrity');

function state(path, fingerprint, status = ' M') {
  return { head: 'HEAD1', entries: [{ path, fingerprint, status, committedStatus: '' }] };
}

test('tool trace delta keeps calls completed in the current turn', () => {
  const before = { completedCount: 1, completed: [{ toolName: 'view', detail: 'a.rs', success: true }] };
  const after = {
    completedCount: 3,
    completed: [
      ...before.completed,
      { toolName: 'builtin:bash', detail: 'cargo fmt', success: true, durationMs: 20 },
      { toolName: 'report_review', detail: '', success: true, durationMs: 1 },
    ],
  };
  assert.deepEqual(toolTraceDelta(before, after).map((item) => item.toolName), ['builtin:bash', 'report_review']);
});

test('integrity incident records changed paths, tools and reviewer report', () => {
  const incident = createReviewerMutationIncident({
    taskId: '1-T1',
    reviewCycle: 3,
    beforeRevision: 'BEFORE',
    afterRevision: 'AFTER',
    beforeState: state('src/lib.rs', 'old'),
    afterState: state('src/lib.rs', 'new'),
    beforeTrace: { completedCount: 0, completed: [] },
    afterTrace: { completedCount: 1, completed: [{ toolName: 'builtin:bash', detail: 'cargo fmt', success: true }] },
    reviewerReport: { verdict: 'clean', summary: 'Looks correct', checks: ['cargo test passed'] },
  });
  assert.equal(incident.changedPathCount, 1);
  assert.equal(incident.changedPaths[0].path, 'src/lib.rs');
  assert.equal(incident.tools[0].detail, 'cargo fmt');
  assert.equal(incident.reviewerReport.verdict, 'clean');
});