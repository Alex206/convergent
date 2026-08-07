'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RESUME_STATE_VERSION, normalizeResumeState, resumeSummary } = require('../src/orchestrator/resume');

const plan = {
  summary: 'two tasks',
  tasks: [
    { id: 'T1', title: 'First task' },
    { id: 'T2', title: 'Second task' },
  ],
};

test('resume state restarts an interrupted current task instead of completed tasks', () => {
  const state = normalizeResumeState({
    version: RESUME_STATE_VERSION,
    workspace: 'C:/repo',
    request: 'implement both tasks',
    plan,
    status: 'interrupted',
    nextTaskIndex: 1,
    currentTaskIndex: 1,
    stats: { tasks: 2, readOnly: 1 },
  }, 'C:/repo');

  assert.equal(state.startTaskIndex, 1);
  assert.equal(state.currentTaskIndex, 1);
  assert.equal(state.stats.tasks, 2);
  assert.match(resumeSummary(state), /restart interrupted task 2/i);
});

test('resume state continues with next pending task from a task boundary', () => {
  const state = normalizeResumeState({
    version: RESUME_STATE_VERSION,
    workspace: '/repo',
    request: 'do work',
    plan,
    status: 'running',
    nextTaskIndex: 1,
    currentTaskIndex: null,
  }, '/repo');

  assert.equal(state.startTaskIndex, 1);
  assert.match(resumeSummary(state), /continue with task 2/i);
});

test('planning interruption keeps enough state to re-run planning without retyping the request', () => {
  const state = normalizeResumeState({
    version: RESUME_STATE_VERSION,
    workspace: '/repo',
    request: 'the original complex request',
    plan: null,
    status: 'interrupted',
    stage: 'planning',
  }, '/repo');

  assert.equal(state.plan, null);
  assert.equal(state.startTaskIndex, 0);
  assert.match(resumeSummary(state), /re-run planning/i);
});

test('resume state rejects another workspace, completed runs, unknown schema versions, and planless non-planning states', () => {
  const base = {
    version: RESUME_STATE_VERSION,
    workspace: '/repo',
    request: 'do work',
    plan,
    status: 'running',
    nextTaskIndex: 0,
  };
  assert.equal(normalizeResumeState(base, '/other'), null);
  assert.equal(normalizeResumeState({ ...base, status: 'complete' }, '/repo'), null);
  assert.equal(normalizeResumeState({ ...base, version: 99 }, '/repo'), null);
  assert.equal(normalizeResumeState({ ...base, nextTaskIndex: 2 }, '/repo'), null);
  assert.equal(normalizeResumeState({ ...base, plan: null, stage: 'task_started' }, '/repo'), null);
});
