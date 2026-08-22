'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  operatorQuestionWithBlockerContext,
  boundedRecoveryItems,
} = require('../src/orchestrator/recovery-engine');

test('operator recovery question includes the blocked report context needed for a scope decision', () => {
  const question = operatorQuestionWithBlockerContext(
    'Should the worker expand scope or preserve the narrow fix?',
    {
      summary: 'The narrow include fix is complete, but an independent host harness defect still blocks 22/22.',
      findings: ['Parameterized private-call harness still fails independently of the include fix.'],
      checks: [
        'Focused CASUT regressions passed.',
        'Real SSP invocation confirmed the malformed include is gone.',
      ],
    },
  );

  assert.match(question, /expand scope/i);
  assert.match(question, /Blocked report context:/);
  assert.match(question, /narrow include fix is complete/i);
  assert.match(question, /private-call harness/i);
  assert.match(question, /Focused CASUT regressions passed/i);
  assert.match(question, /malformed include is gone/i);
});

test('review finding objects are rendered with severity, title, file, and description', () => {
  const question = operatorQuestionWithBlockerContext('How should I proceed?', {
    findings: [{ severity: 'high', title: 'Lock confirmation missing', file: 'migration.py', description: 'Source lock is not confirmed after migration.' }],
  });

  assert.match(question, /\[high\]/i);
  assert.match(question, /Lock confirmation missing/);
  assert.match(question, /migration\.py/);
  assert.match(question, /Source lock is not confirmed/);
});

test('operator recovery report detail is bounded for chat without losing the fact that more exists', () => {
  const items = boundedRecoveryItems(Array.from({ length: 20 }, (_, index) => `check-${index}`));
  assert.equal(items.length, 13);
  assert.equal(items[0], 'check-0');
  assert.match(items.at(-1), /8 more item\(s\) omitted/i);
});

test('question remains unchanged when no blocker detail is available', () => {
  assert.equal(operatorQuestionWithBlockerContext('Retry?', {}), 'Retry?');
});
