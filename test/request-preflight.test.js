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

test('detects short cross-chat handoff phrases that do not contain an objective', () => {
  for (const request of [
    'implement this',
    'please do it',
    'continue',
    'go ahead',
    'take it from here',
    'implement this and add focused tests',
    'continue the previous discussion',
  ]) {
    assert.equal(referencesMissingObjective(request), true, request);
  }
  assert.equal(referencesMissingObjective('Fix this parser regression and add a test.'), false);
  assert.equal(referencesMissingObjective('Implement this parser regression fix and add focused tests.'), false);
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

  assert.match(question, /concrete task|short handoff/i);
  assert.match(question, /normal Copilot agent/i);
  assert.equal(result.clarified, true);
  assert.equal(result.request, 'Add support for deterministic recovery.');
});

test('cross-chat shorthand requires a concrete handoff rather than guessing from unavailable history', async () => {
  let asked = false;
  const result = await ensureConcreteUserRequest('implement this', async () => {
    asked = true;
    return {
      answer: 'Implement the parser fallback discussed earlier; keep the public API unchanged and add focused tests.',
      wasFreeform: true,
    };
  });

  assert.equal(asked, true);
  assert.equal(result.clarified, true);
  assert.match(result.request, /parser fallback/);
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

  await assert.rejects(
    () => ensureConcreteUserRequest('implement this', async () => ({ answer: 'continue', wasFreeform: true })),
    (error) => error.code === 'CONVERGENT_MISSING_REQUEST',
  );
});
