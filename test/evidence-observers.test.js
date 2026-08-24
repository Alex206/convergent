'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TRUST_BOUNDARY_REVIEW_AUDIT_CONTRACT,
} = require('../src/headless/review-evidence-auditor');
const {
  PATH_RESOLUTION_OBSERVER_ID,
  EvidenceObserverRegistry,
  createPathResolutionTransitionObserver,
  pathResolutionObserverApplicability,
  validateObserver,
} = require('../src/headless/evidence-observers');

function stubObserver(id = 'stub-v1', applicability = () => true, auditContract = TRUST_BOUNDARY_REVIEW_AUDIT_CONTRACT) {
  return {
    id,
    schemaVersion: 1,
    evidenceType: 'test.stub',
    toolName: 'custom:observe_stub',
    reviewerPrompt: 'STUB REVIEWER PROMPT',
    auditorPrompt: 'STUB AUDITOR PROMPT',
    auditContract,
    metadata: { oracleBlind: true },
    applicability,
    createTool({ observationSink }) {
      return { name: 'observe_stub', observationSink };
    },
    compactEvidence(observations, revision) {
      return observations.filter((entry) => entry.revision === revision).map((entry) => entry.value);
    },
    augmentReview(review, evidence, revision) {
      return {
        ...review,
        checks: [...(review.checks ?? []), `stub:${revision}:${JSON.stringify(evidence)}`],
      };
    },
  };
}

test('typed evidence observer registry validates stable unique capability contracts', () => {
  assert.throws(() => validateObserver({ id: 'missing' }), /evidenceType/);
  assert.throws(
    () => validateObserver({
      id: 'missing-contract',
      evidenceType: 'test',
      toolName: 'custom:test',
      applicability() { return true; },
      createTool() {},
      compactEvidence() {},
      augmentReview() {},
    }),
    /auditContract/,
  );
  assert.throws(
    () => new EvidenceObserverRegistry([stubObserver('same'), stubObserver('same')]),
    /Duplicate evidence observer id/,
  );

  const registry = new EvidenceObserverRegistry([createPathResolutionTransitionObserver()]);
  assert.deepEqual(registry.metadata().map((entry) => entry.id), [PATH_RESOLUTION_OBSERVER_ID]);
  assert.equal(registry.metadata()[0].oracleBlind, true);
  assert.equal(registry.metadata()[0].revisionBound, true);
  assert.equal(registry.metadata()[0].typedTransitions, true);
  assert.equal(registry.metadata()[0].auditContract, 'trust-boundary-composition-v1');
  assert.equal(registry.auditContract().id, 'trust-boundary-composition-v1');
});

test('observer applicability is explicit and fail-closed', () => {
  const registry = new EvidenceObserverRegistry([
    stubObserver('yes', () => ({ applicable: true, reason: 'matched' })),
    stubObserver('no', () => ({ applicable: false, reason: 'not-matched' })),
    stubObserver('throws', () => { throw new Error('bad selector'); }),
  ]);
  const selected = registry.selectApplicable({ task: { title: 'task' } });
  assert.deepEqual(selected.registry.metadata().map((entry) => entry.id), ['yes']);
  assert.deepEqual(selected.decisions.map((entry) => [entry.observerId, entry.applicable]), [
    ['yes', true],
    ['no', false],
    ['throws', false],
  ]);
  assert.match(selected.decisions[2].reason, /^applicability-error:/);
});

test('selected observers must agree on one audit contract', () => {
  const otherContract = {
    id: 'other-v1',
    prompt: 'Judge the other evidence contract and call report_review_audit.',
    aspects: [['other_evidence', 'show other evidence']],
  };
  const registry = new EvidenceObserverRegistry([
    stubObserver('one'),
    stubObserver('two', () => true, otherContract),
  ]);
  assert.throws(() => registry.auditContract(), /incompatible audit contracts/i);
});

test('path transition observer requires an explicit high-risk artifact-path boundary contract', () => {
  const task = {
    title: 'Fix artifact path containment security boundary',
    description: 'Fix resolve_artifact_path(root, artifact_path).',
    acceptanceCriteria: ['Reject symlink escapes and preserve normalized in-root paths.'],
  };
  assert.equal(pathResolutionObserverApplicability({ task, routing: { route: 'high_risk' } }).applicable, true);
  assert.equal(pathResolutionObserverApplicability({ task, routing: { route: 'standard' } }).applicable, false);
  assert.equal(pathResolutionObserverApplicability({
    task: { title: 'Rotate signing credentials', description: 'Update release secret handling.' },
    routing: { route: 'high_risk' },
  }).applicable, false);
});

test('observer registry keeps observations isolated by capability and exact revision', () => {
  const registry = new EvidenceObserverRegistry([stubObserver()]);
  const state = registry.createObservationState();
  state.get('stub-v1').push(
    { revision: 'old', value: 'stale' },
    { revision: 'current', value: 'fresh' },
  );

  assert.deepEqual(registry.evidenceForRevision(state, 'current'), [{
    observerId: 'stub-v1',
    schemaVersion: 1,
    evidenceType: 'test.stub',
    observations: ['fresh'],
  }]);

  const augmented = registry.augmentReview({ checks: ['review'] }, state, 'current');
  assert.deepEqual(augmented.packets[0].observations, ['fresh']);
  assert.deepEqual(augmented.review.checks, ['review', 'stub:current:["fresh"]']);
});

test('observer registry injects only declared reviewer tools and prompts', async () => {
  let capturedOptions = null;
  const baseClient = {
    async createSession(options) {
      capturedOptions = options;
      return { options };
    },
  };
  const registry = new EvidenceObserverRegistry([stubObserver()]);
  const state = registry.createObservationState();
  const factory = {
    sdk: { defineTool: (name, spec) => ({ name, spec }) },
    workspace: '/workspace',
    workspaceFolders: [],
  };

  const client = registry.injectReviewerClient(baseClient, factory, state);
  await client.createSession({
    tools: [{ name: 'existing' }],
    availableTools: ['builtin:view'],
    systemMessage: { mode: 'append', content: 'BASE' },
  });

  assert.equal(capturedOptions.tools.length, 2);
  assert.deepEqual(capturedOptions.availableTools, ['builtin:view', 'custom:observe_stub']);
  assert.match(capturedOptions.systemMessage.content, /BASE/);
  assert.match(capturedOptions.systemMessage.content, /STUB REVIEWER PROMPT/);
  assert.equal(registry.auditorPrompt(), 'STUB AUDITOR PROMPT');
});

test('empty observer registry is a fail-safe no-op rather than weakening review', async () => {
  const baseClient = { async createSession(options) { return options; } };
  const registry = new EvidenceObserverRegistry([]);
  const state = registry.createObservationState();
  assert.equal(registry.injectReviewerClient(baseClient, {}, state), baseClient);
  assert.deepEqual(registry.evidenceForRevision(state, 'revision'), []);
  assert.deepEqual(registry.metadata(), []);
  assert.equal(registry.auditorPrompt(), '');
  assert.equal(registry.auditContract(), null);
  assert.deepEqual(registry.selectApplicable({}).decisions, []);
});
