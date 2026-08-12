'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  defaultCopilotSessionConfig,
} = require('../src/headless/default-copilot-engine');
const {
  normalizeBenchmarkArchitecture,
  benchmarkArchitectureMetadata,
} = require('../src/headless/architecture-catalog');
const {
  architectureRelevantModelIssues,
  recordActualModelEvent,
} = require('../src/headless/architecture-runner');

const MODELS = [
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', supportedReasoningEfforts: ['low', 'medium'] },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
];

test('neutral Copilot baseline is distinct from Convergent Worker A topology', () => {
  assert.equal(normalizeBenchmarkArchitecture('copilot'), 'copilot-default');
  assert.equal(normalizeBenchmarkArchitecture('default-agent'), 'copilot-default');
  const metadata = benchmarkArchitectureMetadata('copilot-default', { workerA: 'auto' });
  assert.equal(metadata.defaultCopilotPersona, true);
  assert.equal(metadata.customConvergentTools, false);
  assert.deepEqual(metadata.activeRoles, ['default-agent']);
  assert.deepEqual(metadata.selectors, { defaultAgent: 'auto' });
});

test('default Auto session deliberately omits model and all Convergent prompt/tool overrides', () => {
  const permissionHandler = async () => ({ kind: 'approve-once' });
  const userInputHandler = async () => ({ answer: '' });
  const { config, resolution } = defaultCopilotSessionConfig({
    runId: 'run',
    workspace: '/repo',
    selector: 'auto',
    available: MODELS,
    permissionHandler,
    userInputHandler,
  });
  assert.equal(resolution.id, 'auto');
  assert.equal(config.model, undefined);
  assert.equal(config.workingDirectory, '/repo');
  assert.equal(config.streaming, true);
  assert.equal(config.onPermissionRequest, permissionHandler);
  assert.equal(config.onUserInputRequest, userInputHandler);
  assert.equal(Object.hasOwn(config, 'systemMessage'), false);
  assert.equal(Object.hasOwn(config, 'tools'), false);
  assert.equal(Object.hasOwn(config, 'availableTools'), false);
  assert.equal(Object.hasOwn(config, 'hooks'), false);
  assert.equal(Object.hasOwn(config, 'reasoningEffort'), false);
});

test('explicit strong default Copilot baseline changes only the requested model', () => {
  const { config, resolution } = defaultCopilotSessionConfig({
    runId: 'run',
    workspace: '/repo',
    selector: 'strong',
    available: MODELS,
  });
  assert.equal(resolution.id, 'gpt-5.6-terra');
  assert.equal(config.model, 'gpt-5.6-terra');
  assert.equal(Object.hasOwn(config, 'systemMessage'), false);
  assert.equal(Object.hasOwn(config, 'tools'), false);
  assert.equal(Object.hasOwn(config, 'availableTools'), false);
  assert.equal(Object.hasOwn(config, 'hooks'), false);
  assert.equal(Object.hasOwn(config, 'reasoningEffort'), false);
});

test('default Copilot model preflight cares only about the requested default-agent selector', () => {
  const issues = [
    { role: 'coordinator' },
    { role: 'workerA' },
    { role: 'workerB' },
    { role: 'reviewer' },
  ];
  assert.deepEqual(
    architectureRelevantModelIssues('copilot-default', issues).map((item) => item.role),
    ['workerA'],
  );
});

test('actual model provenance records routed models reported by assistant.usage', () => {
  const records = [];
  recordActualModelEvent(records, {
    type: 'session_create',
    sessionId: 's1',
    agent: 'Default Copilot agent',
    role: 'default-agent',
    model: 'auto',
    modelName: 'Copilot default/Auto',
  });
  recordActualModelEvent(records, {
    type: 'assistant_usage',
    sessionId: 's1',
    data: { model: 'gpt-5.4-mini' },
  });
  recordActualModelEvent(records, {
    type: 'assistant_usage',
    sessionId: 's1',
    data: { model: 'gpt-5.6-terra' },
  });
  recordActualModelEvent(records, {
    type: 'assistant_usage',
    sessionId: 's1',
    data: { model: 'gpt-5.4-mini' },
  });
  assert.deepEqual(records[0].routedModels, ['gpt-5.4-mini', 'gpt-5.6-terra']);
});
