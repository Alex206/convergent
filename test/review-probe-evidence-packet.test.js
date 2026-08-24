'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REVIEW_AUDITOR_BOUNDARY_PROMPT,
  compactProbeEvidence,
  augmentReviewWithProgrammaticProbeEvidence,
} = require('../src/headless/review-evidence-auditor-cli');

function observation(revision, artifactPath, accepted = true) {
  return {
    revision,
    spec: {
      root_name: 'work',
      directories: ['outside'],
      symlinks: [{ path: 'work/escape', target: 'outside' }],
      cases: [{ label: artifactPath, artifact_path: artifactPath }],
    },
    result: {
      symlink_supported: true,
      symlink_error: null,
      results: [{ label: artifactPath, artifact_path: artifactPath, accepted }],
    },
  };
}

test('auditor probe packet contains only evidence from the exact current revision', () => {
  const evidence = compactProbeEvidence([
    observation('old-revision', 'stale'),
    observation('current-revision', 'hostile', false),
    observation('current-revision', 'benign', true),
  ], 'current-revision');

  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence.map((entry) => entry.cases[0].artifact_path), ['hostile', 'benign']);
  assert.equal(JSON.stringify(evidence).includes('stale'), false);
});

test('auditor probe packet stays bounded even when reviewer probes repeatedly', () => {
  const observations = Array.from({ length: 7 }, (_, index) => observation('current', `case-${index}`));
  const evidence = compactProbeEvidence(observations, 'current');
  assert.equal(evidence.length, 4);
  assert.deepEqual(
    evidence.map((entry) => entry.cases[0].artifact_path),
    ['case-3', 'case-4', 'case-5', 'case-6'],
  );
});

test('programmatic probe evidence is marked authoritative inside the bounded review packet', () => {
  const augmented = augmentReviewWithProgrammaticProbeEvidence(
    { verdict: 'clean', summary: 'clean', findings: [], checks: ['reviewer claim'] },
    compactProbeEvidence([observation('revision-123', 'hostile', false)], 'revision-123'),
    'revision-123',
  );
  assert.equal(augmented.checks[0], 'reviewer claim');
  assert.match(augmented.checks[1], /PROGRAMMATIC PROBE EVIDENCE/);
  assert.match(augmented.checks[1], /authoritative/);
  assert.match(augmented.checks[1], /revision-123/);
  assert.match(augmented.checks[1], /hostile/);
});

test('low-context auditor guidance requires final-state masking and provenance-matched boundary transitions', () => {
  assert.match(REVIEW_AUDITOR_BOUNDARY_PROMPT, /final-state-only/i);
  assert.match(REVIEW_AUDITOR_BOUNDARY_PROMPT, /BOTH witnesses must actually exercise/i);
  assert.match(REVIEW_AUDITOR_BOUNDARY_PROMPT, /provenance\/mechanism/i);
  assert.match(REVIEW_AUDITOR_BOUNDARY_PROMPT, /stale evidence/i);
  assert.match(REVIEW_AUDITOR_BOUNDARY_PROMPT, /current revision/i);
});