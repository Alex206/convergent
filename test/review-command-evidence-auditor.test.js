'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REVIEWER_COMMAND_EVIDENCE_PROMPT,
  REVIEW_AUDITOR_COMMAND_EVIDENCE_PROMPT,
  augmentReviewWithProgrammaticCommandEvidence,
} = require('../src/headless/review-command-evidence-auditor-cli');

function evidence(command = 'python -m unittest tests.test_paths') {
  return [{
    id: 'command-1',
    command,
    cwd: '.',
    workspace_folder: '',
    timeout_seconds: 30,
    tool_success: true,
    state: 'completed',
    exit_code: 0,
    signal: null,
    error: '',
    stdout: 'observed result',
    stderr: '',
    stdout_truncated: false,
    stderr_truncated: false,
    elapsed_ms: 20,
  }];
}

test('command evidence packet is explicit, authoritative only as execution record, and revision-bound', () => {
  const augmented = augmentReviewWithProgrammaticCommandEvidence(
    { verdict: 'clean', summary: 'clean', findings: [], checks: ['review claim'] },
    evidence(),
    'revision-1234567890',
  );
  assert.equal(augmented.checks[0], 'review claim');
  assert.match(augmented.checks[1], /PROGRAMMATIC COMMAND EVIDENCE/);
  assert.match(augmented.checks[1], /authoritative execution record/i);
  assert.match(augmented.checks[1], /revision-1234567890/);
  assert.match(augmented.checks[1], /python -m unittest/);
});

test('reviewer guidance requires performed discriminating evidence without a domain-specific probe', () => {
  assert.match(REVIEWER_COMMAND_EVIDENCE_PROMPT, /run_command/);
  assert.match(REVIEWER_COMMAND_EVIDENCE_PROMPT, /actual implementation/i);
  assert.match(REVIEWER_COMMAND_EVIDENCE_PROMPT, /hostile and benign contrast/i);
  assert.match(REVIEWER_COMMAND_EVIDENCE_PROMPT, /over-restrictive remediation/i);
});

test('low-context auditor treats captured commands as evidence, not an oracle', () => {
  assert.match(REVIEW_AUDITOR_COMMAND_EVIDENCE_PROMPT, /not an oracle/i);
  assert.match(REVIEW_AUDITOR_COMMAND_EVIDENCE_PROMPT, /merely echoes an expected answer/i);
  assert.match(REVIEW_AUDITOR_COMMAND_EVIDENCE_PROMPT, /current-revision performed evidence/i);
  assert.match(REVIEW_AUDITOR_COMMAND_EVIDENCE_PROMPT, /repository access off/i);
});
