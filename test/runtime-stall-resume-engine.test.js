'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResumableConvergentEngine } = require('../src/orchestrator/resumable-engine');

const task = {
  id: 'task-1',
  title: 'Task one',
  description: 'Do work',
  acceptanceCriteria: ['done'],
};
const routing = { route: 'standard', risk: 'medium', peerConvergence: false };

function engine(phases = []) {
  return new ResumableConvergentEngine({
    client: {},
    sdk: {},
    workspace: '/repo',
    models: {},
    ui: { phase: (name, detail) => phases.push({ name, detail }) },
    revisionProvider: async () => 'REV',
    onCheckpoint: async () => {},
  });
}

test('unproven runtime-stall resume pauses before creating any agent session', async () => {
  let creates = 0;
  const factory = {
    async createWorker() { creates += 1; throw new Error('must not create worker'); },
    async createReviewer() { creates += 1; throw new Error('must not create reviewer'); },
  };
  const resume = {
    stage: 'worker_runtime_stall',
    runtimeIncident: {
      termination: { active: true, proven: false, commandId: 'cmd-old', pid: 999 },
    },
  };

  await assert.rejects(
    () => engine().runFullTask(factory, task, '1-task-1', routing, resume),
    (error) => {
      assert.equal(error.code, 'CONVERGENT_PAUSED');
      assert.equal(error.details?.kind, 'runtime_stall_resume_unproven');
      assert.match(error.message, /No new agent or command was started/i);
      return true;
    },
  );
  assert.equal(creates, 0);
});
