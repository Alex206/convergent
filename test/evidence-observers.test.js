'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PATH_RESOLUTION_OBSERVER_ID,
  EvidenceObserverRegistry,
  createPathResolutionTransitionObserver,
  validateObserver,
} = require('../src/headless/evidence-observers');

function stubObserver(id = 'stub-v1') {
  return {
    id,
    schemaVersion: 1,
    evidenceType: 'test.stub',
    toolName: 'custom:observe_stub',
    reviewerPrompt: 'STUB REVIEWER PROMPT',
    auditorPrompt: 'STUB AUDITOR PROMPT',
    metadata: { oracleBlind: true },
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
    () => new EvidenceObserverRegistry([stubObserver('same'), stubObserver('same')]),
    /Duplicate evidence observer id/,
  );

  const registry = new EvidenceObserverRegistry([createPathResolutionTransitionObserver()]);
  assert.deepEqual(registry.metadata().map((entry) => entry.id), [PATH_RESOLUTION_OBSERVER_ID]);
  assert.equal(registry.metadata()[0].oracleBlind, true);
  assert.equal(registry.metadata()[0].revisionBound, true);
  assert.equal(registry.metadata()[0].typedTransitions, true);
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
});
