'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveModel } = require('../src/orchestrator/model-resolver');

const models = [
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', supportedReasoningEfforts: ['low', 'medium'] },
  { id: 'gpt-5.4', name: 'GPT-5.4' },
];

test('strong preset chooses strong model', () => {
  assert.equal(resolveModel('strong', models).id, 'gpt-5.4');
});

test('planner preset prefers capable lightweight model over strong model', () => {
  const result = resolveModel('planner', models);
  assert.equal(result.id, 'gpt-5.4-mini');
  assert.match(result.reason, /planner preset/);
  assert.deepEqual(result.supportedReasoningEfforts, ['low', 'medium']);
});

test('planner and tool-heavy worker A prefer GPT-5.6 Luna when available', () => {
  const withLuna = [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }, ...models];
  assert.equal(resolveModel('planner', withLuna).id, 'gpt-5.6-luna');
  assert.equal(resolveModel('cheap-a', withLuna).id, 'gpt-5.6-luna');
});

test('cheap presets diversify workers when Luna is absent', () => {
  assert.equal(resolveModel('cheap-a', models).id, 'claude-haiku-4.5');
  assert.equal(resolveModel('cheap-b', models).id, 'gemini-3-flash');
});

test('cheap-b can exclude worker A model and pick another cheap model', () => {
  const withoutGemini = [
    { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
  ];
  assert.equal(
    resolveModel('cheap-b', withoutGemini, { excludeIds: ['claude-haiku-4.5'] }).id,
    'gpt-5.4-mini',
  );
});

test('cheap-b reuses the same cheap model instead of auto when no diverse cheap model exists', () => {
  const onlyHaiku = [{ id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' }];
  const result = resolveModel('cheap-b', onlyHaiku, { excludeIds: ['claude-haiku-4.5'] });
  assert.equal(result.id, 'claude-haiku-4.5');
  assert.match(result.reason, /no different cheap model available/);
});

test('exact model id wins even when it matches an excluded peer model', () => {
  assert.equal(
    resolveModel('claude-haiku-4.5', models, { excludeIds: ['claude-haiku-4.5'] }).id,
    'claude-haiku-4.5',
  );
});

test('exact model id wins', () => {
  assert.equal(resolveModel('gemini-3-flash', models).id, 'gemini-3-flash');
});

test('unavailable selector falls back to auto', () => {
  assert.equal(resolveModel('does-not-exist', models).id, 'auto');
});

test('cheap-b does not accidentally select a more expensive Gemini 3.5 Flash model', () => {
  const mixed = [
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
    { id: 'gpt-5.4-nano', name: 'GPT-5.4 nano' },
  ];
  assert.equal(resolveModel('cheap-b', mixed).id, 'gpt-5.4-nano');
});
