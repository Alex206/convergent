'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  referencesMissingObjective,
  ensureConcreteUserRequest,
} = require('../src/orchestrator/request-preflight');

test('detects a referenced request that was not actually included', () => {
  assert.equal(referencesMissingObjective('you got interrupted. This was the request'), true);
  assert.equal(referencesMissingObjective('Here is the prompt:'), true);
  assert.equal(referencesMissingObjective('This was the request: add a parser test'), false);
});

test('preflight asks for the missing objective before coordinator execution', async () => {
  let question;
  const result = await ensureConcreteUserRequest(
    'you got interrupted. This was the request',
    async (request) => {
      question = request.question;
      return { answer: 'Add support for deterministic recovery.', wasFreeform: true };
    },
  );

  assert.match(question, /actual request/i);
  assert.equal(result.clarified, true);
  assert.equal(result.request, 'Add support for deterministic recovery.');
});

test('concrete requests pass through without asking for clarification', async () => {
  let asked = false;
  const result = await ensureConcreteUserRequest('Fix the parser regression and add a test.', async () => {
    asked = true;
    return { answer: 'unused' };
  });

  assert.equal(asked, false);
  assert.deepEqual(result, { request: 'Fix the parser regression and add a test.', clarified: false });
});

test('cancelled or still-missing clarification fails instead of inventing an objective', async () => {
  await assert.rejects(
    () => ensureConcreteUserRequest('This was the request:', async () => ({ answer: 'User cancelled the clarification request.', wasFreeform: true })),
    (error) => error.code === 'CONVERGENT_MISSING_REQUEST',
  );

  await assert.rejects(
    () => ensureConcreteUserRequest('This was the request:', async () => ({ answer: 'Here is the prompt:', wasFreeform: true })),
    (error) => error.code === 'CONVERGENT_MISSING_REQUEST',
  );
});
