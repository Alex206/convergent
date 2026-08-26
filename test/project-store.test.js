'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileProjectEventStore, eventFileName } = require('../src/project/store');

function event(id, type, data = {}) {
  return { id, type, data };
}

test('file project event store persists immutable replayable events across store instances', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-project-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const store = new FileProjectEventStore(root);
  await store.append('P1', event('e1', 'PROJECT_CREATED', { projectId: 'P1', objective: 'Durable project', budgetTotal: 10 }));
  await store.append('P1', event('e2', 'DISCOVERY_STARTED'));
  await store.append('P1', event('e3', 'REQUIREMENT_ADDED', { id: 'R1', text: 'Survive process/session replacement.' }));

  const replacementProcessStore = new FileProjectEventStore(root);
  const state = await replacementProcessStore.load('P1');
  assert.equal(state.id, 'P1');
  assert.equal(state.revision, 3);
  assert.equal(state.status, 'discovery');
  assert.equal(state.requirements[0].text, 'Survive process/session replacement.');

  const directory = replacementProcessStore.projectDirectory('P1');
  assert.deepEqual((await fs.readdir(directory)).sort(), [eventFileName(1), eventFileName(2), eventFileName(3)]);
});

test('file project event store treats replay of the same event as idempotent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-project-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const store = new FileProjectEventStore(root);
  const create = event('e1', 'PROJECT_CREATED', { projectId: 'P1', objective: 'Durable project' });
  const first = await store.append('P1', create);
  const second = await store.append('P1', create);
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
  assert.deepEqual(await store.loadEvents('P1'), [create]);
});

test('file project event store rejects project-id mismatch and conflicting event-id reuse', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-project-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const store = new FileProjectEventStore(root);
  await assert.rejects(
    () => store.append('P1', event('e1', 'PROJECT_CREATED', { projectId: 'P2', objective: 'wrong project' })),
    /not 'P1'/i,
  );

  await store.append('P1', event('e1', 'PROJECT_CREATED', { projectId: 'P1', objective: 'correct project' }));
  await store.append('P1', event('e2', 'DISCOVERY_STARTED'));
  await store.append('P1', event('e3', 'REQUIREMENT_ADDED', { id: 'R1', text: 'original' }));
  await assert.rejects(
    () => store.append('P1', event('e3', 'REQUIREMENT_ADDED', { id: 'R1', text: 'conflict' })),
    /reused with different content/i,
  );
});