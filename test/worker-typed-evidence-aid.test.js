'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WORKER_TYPED_EVIDENCE_AID_PROMPT,
  envFlag,
  createDefaultEvidenceObserverRegistry,
  ProbeEnabledReviewEvidenceAuditorSessionFactory,
} = require('../src/headless/review-evidence-auditor-cli');

function pathTask() {
  return {
    title: 'Artifact path containment',
    description: 'Fix resolve_artifact_path and reject symlink escapes from the artifact root.',
    acceptanceCriteria: ['Reject a path component that resolves through a symlink outside the root.'],
  };
}

function configuredFactory() {
  const factory = Object.create(ProbeEnabledReviewEvidenceAuditorSessionFactory.prototype);
  factory.defaultReviewAuditContract = { id: 'default' };
  factory.availableEvidenceObservers = createDefaultEvidenceObserverRegistry();
  factory.evidenceObservers = null;
  factory.evidenceObservationState = null;
  factory.workerEvidenceObservationState = null;
  factory.evidenceObserverApplicability = [];
  factory.reviewAuditContract = factory.defaultReviewAuditContract;
  factory.workspace = process.cwd();
  factory.workspaceFolders = [process.cwd()];
  factory.sdk = {
    defineTool(name, spec) {
      return { name, spec };
    },
  };
  factory.configureEvidenceObservers({
    task: pathTask(),
    routing: { route: 'high_risk', risk: 'high' },
  });
  return factory;
}

test('worker evidence aid environment flag is explicit and conservative', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(envFlag(value), true);
  for (const value of [undefined, '', '0', 'false', 'enabled', 'no']) assert.equal(envFlag(value), false);
});

test('worker and reviewer typed observations use isolated state', () => {
  const factory = configuredFactory();
  assert.notEqual(factory.workerEvidenceObservationState, factory.evidenceObservationState);

  const reviewerSink = factory.evidenceObservationState.get('path-resolution-transition-v1');
  const workerSink = factory.workerEvidenceObservationState.get('path-resolution-transition-v1');
  assert.ok(Array.isArray(reviewerSink));
  assert.ok(Array.isArray(workerSink));
  assert.notEqual(workerSink, reviewerSink);

  const evidence = {
    revision: 'rev',
    spec: { root_name: 'work', directories: [], symlinks: [], cases: [{ artifact_path: 'a' }] },
    result: { symlink_supported: true, symlink_error: null, results: [{ label: 'a' }] },
  };
  workerSink.push({ ...evidence, result: { ...evidence.result, results: [{ label: 'worker-only' }] } });
  reviewerSink.push({ ...evidence, result: { ...evidence.result, results: [{ label: 'reviewer-only' }] } });

  assert.equal(factory.workerObserverEvidenceForRevision('rev')[0].observations[0].results[0].label, 'worker-only');
  assert.equal(factory.observerEvidenceForRevision('rev')[0].observations[0].results[0].label, 'reviewer-only');
});

test('worker aid client exposes selected typed tools but marks them as non-authoritative self-checks', async () => {
  const factory = configuredFactory();
  let captured = null;
  const baseClient = {
    async createSession(options) {
      captured = options;
      return { options };
    },
  };

  const aidedClient = factory.workerEvidenceAidClient(baseClient);
  await aidedClient.createSession({
    tools: [{ name: 'base' }],
    availableTools: ['builtin:view'],
    systemMessage: { mode: 'append', content: 'BASE WORKER PROMPT' },
  });

  assert.ok(captured);
  assert.ok(captured.availableTools.includes('custom:probe_path_resolution'));
  assert.ok(captured.tools.some((tool) => tool.name === 'probe_path_resolution'));
  assert.match(captured.systemMessage.content, /IMPLEMENTER TYPED-EVIDENCE AID/);
  assert.match(captured.systemMessage.content, /not approval evidence/i);
  assert.match(captured.systemMessage.content, /independent reviewer must execute/i);
  assert.match(captured.systemMessage.content, /probe_path_resolution/);
  assert.match(WORKER_TYPED_EVIDENCE_AID_PROMPT, /report_pass/);
});

test('review augmentation never consumes Worker A observation state', () => {
  const factory = configuredFactory();
  const workerSink = factory.workerEvidenceObservationState.get('path-resolution-transition-v1');
  workerSink.push({
    revision: 'rev',
    spec: { root_name: 'work', directories: [], symlinks: [], cases: [{ artifact_path: 'worker' }] },
    result: { symlink_supported: true, symlink_error: null, results: [{ label: 'worker-evidence' }] },
  });

  const augmented = factory.augmentReviewWithObserverEvidence({ checks: ['review-base'] }, 'rev');
  assert.equal(augmented.packets[0].observations.length, 0);
  assert.match(augmented.review.checks.at(-1), /"observations":\[\]/);
  assert.doesNotMatch(augmented.review.checks.at(-1), /worker-evidence/);
});
