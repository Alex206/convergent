'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveModel } = require('../src/orchestrator/model-resolver');

const models = [
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
  { id: 'gpt-5.4', name: 'GPT-5.4' },
];

test('strong preset chooses strong model', () => {
  assert.equal(resolveModel('strong', models).id, 'gpt-5.4');
});

test('cheap presets diversify workers', () => {
  assert.equal(resolveModel('cheap-a', models).id, 'claude-haiku-4.5');
  assert.equal(resolveModel('cheap-b', models).id, 'gemini-3-flash');
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
