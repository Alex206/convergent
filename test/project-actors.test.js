'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROJECT_ACTORS } = require('../src/project/actors');

test('project manager is strong but episodic rather than a days-long model session', () => {
  assert.equal(PROJECT_ACTORS.projectManager.modelSelector, 'strong');
  assert.equal(PROJECT_ACTORS.projectManager.sessionLifetime, 'episodic');
  assert.equal(PROJECT_ACTORS.projectManager.authority, 'proposal');
});

test('project architect is conditional and task execution delegates to the existing Convergent engine', () => {
  assert.equal(PROJECT_ACTORS.projectArchitect.sessionLifetime, 'ephemeral');
  assert.match(PROJECT_ACTORS.projectArchitect.activation, /architecture-significant/i);
  assert.equal(PROJECT_ACTORS.taskEngine.id, 'existing-convergent-task-engine');
  assert.ok(PROJECT_ACTORS.taskEngine.responsibilities.includes('task-recovery'));
});