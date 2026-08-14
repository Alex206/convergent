'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTaskRoute,
  routePolicy,
  architectureSignificance,
} = require('../src/orchestrator/routing');
const {
  normalizeArchitectureAssessment,
  formatArchitectureAssessment,
} = require('../src/orchestrator/architecture-advisor');
const { RecoveryConvergentEngine } = require('../src/orchestrator/recovery-engine');

function task(overrides = {}) {
  return {
    id: 't1',
    title: 'Implement change',
    description: 'Implement the requested behavior in the existing module.',
    acceptanceCriteria: ['Behavior is implemented and tested.'],
    route: 'standard',
    risk: 'low',
    routingReason: 'normal implementation',
    ...overrides,
  };
}

test('architecture significance is independent from security risk', () => {
  const localSecurity = normalizeTaskRoute(task({
    title: 'Fix authentication token validation',
    description: 'Tighten one existing credential validation check without changing interfaces or ownership boundaries.',
  }));
  assert.equal(localSecurity.risk, 'high');
  assert.equal(localSecurity.route, 'high_risk');
  assert.equal(localSecurity.architecture, 'low');
  assert.equal(localSecurity.needsArchitect, false);

  const structural = normalizeTaskRoute(task({
    title: 'Introduce runtime abstraction for backend providers',
    description: 'Add a runtime abstraction and backend provider boundary while preserving current behavior.',
    routingReason: 'cross-cutting ownership boundary change',
  }));
  assert.equal(structural.risk, 'low');
  assert.equal(structural.route, 'standard');
  assert.equal(structural.architecture, 'high');
  assert.equal(structural.needsArchitect, true);
  assert.equal(routePolicy(structural.route, structural.risk, structural.architecture).architect, true);
});

test('ordinary modules and local refactors do not automatically pay for an architect', () => {
  assert.equal(architectureSignificance(task({
    title: 'Refactor parser helper',
    description: 'Refactor one parser module locally and preserve its interface.',
  })), 'medium');
  assert.equal(normalizeTaskRoute(task({
    title: 'Refactor parser helper',
    description: 'Refactor one parser module locally and preserve its interface.',
  })).needsArchitect, false);

  assert.equal(architectureSignificance(task({
    title: 'Add helper class',
    description: 'Add one small class in the existing module using current patterns.',
  })), 'low');
});

test('architecture assessment is bounded and explicitly permits no intervention', () => {
  const assessment = normalizeArchitectureAssessment({
    intervention: 'none',
    summary: '',
    affectedBoundaries: [],
    constraints: [],
    recommendedApproach: [],
    patterns: ['Strategy'],
    avoid: [],
  });
  assert.equal(assessment.intervention, 'none');
  assert.match(assessment.summary, /No architectural intervention/);
  const formatted = formatArchitectureAssessment(assessment);
  assert.match(formatted, /Do not add abstractions merely to satisfy this assessment/);
});

function fakeFactory(sessionCounter) {
  const ui = {
    agentTools() {},
    agentConfiguration() {},
    phase() {},
    log() {},
    audit() {},
  };
  return {
    sdk: {
      defineTool(name, spec) {
        return { name, ...spec };
      },
    },
    client: {
      async createSession(options) {
        sessionCounter.count += 1;
        const architectureTool = options.tools.find((tool) => tool.name === 'report_architecture');
        return {
          sessionId: options.sessionId,
          on() { return () => {}; },
          async sendAndWait() {
            await architectureTool.handler({
              intervention: 'constraints',
              summary: 'Keep provider choice behind the existing runtime boundary.',
              affectedBoundaries: ['runtime/session boundary'],
              constraints: ['Do not make orchestration model-aware.'],
              recommendedApproach: ['Extend the existing policy seam.'],
              patterns: [],
              avoid: ['Generic plugin framework.'],
            });
          },
          async disconnect() {},
        };
      },
    },
    models: {
      reviewer: {
        id: 'strong',
        name: 'Strong',
        supportedReasoningEfforts: ['medium', 'high'],
      },
    },
    reasoningMode: 'adaptive',
    workspace: '/repo',
    runId: 'test-run',
    permissionHandler: async () => ({ kind: 'approved' }),
    userInputHandler: async () => ({ answer: '' }),
    ui,
    usage: { register() {} },
    batchViewTool() { return { name: 'batch_view' }; },
    guard() { return {}; },
    sessionCreated() {},
  };
}

class CapturingEngine extends RecoveryConvergentEngine {
  constructor(options) {
    super(options);
    this.checkpoints = [];
    this.captured = null;
  }

  async finishTurn() { return {}; }
  async saveTaskCheckpoint(state) { this.checkpoints.push(state); return state; }
  async createTaskContext() { return { flowMode: 'auto', baselineChangeState: null }; }
  async runFullTask(_factory, taskValue, _key, routingValue, resumeState) {
    this.captured = { task: taskValue, routing: routingValue, resumeState };
    return { route: routingValue.route, escalated: false };
  }
}

test('high architecture runs architect once, checkpoints it, and reuses it on resume', async () => {
  const sessionCounter = { count: 0 };
  const factory = fakeFactory(sessionCounter);
  const engine = new CapturingEngine({
    client: factory.client,
    sdk: factory.sdk,
    workspace: '/repo',
    models: factory.models,
    permissionHandler: factory.permissionHandler,
    userInputHandler: factory.userInputHandler,
    ui: factory.ui,
    revisionProvider: async () => 'same-revision',
    changeStateProvider: async () => ({ head: 'h', staged: [], unstaged: [], untracked: [] }),
  });
  const architecturalTask = task({
    title: 'Introduce runtime abstraction for backend providers',
    description: 'Add a runtime abstraction and backend provider boundary.',
    routingReason: 'cross-cutting ownership boundary change',
  });
  const routing = normalizeTaskRoute(architecturalTask);

  await engine.runTask(factory, architecturalTask, '1-t1', routing, null);
  assert.equal(sessionCounter.count, 1);
  assert.equal(engine.checkpoints[0].stage, 'architecture_assessed');
  assert.equal(engine.checkpoints[0].routing.architectureAssessment.intervention, 'constraints');
  assert.match(engine.captured.task.description, /SOFTWARE ARCHITECT ASSESSMENT/);
  assert.match(engine.captured.task.description, /Do not make orchestration model-aware/);

  const saved = engine.checkpoints[0];
  await engine.runTask(factory, architecturalTask, '1-t1', routing, saved);
  assert.equal(sessionCounter.count, 1, 'resume must reuse the completed architect assessment');
  assert.equal(engine.captured.routing.architectureAssessment.summary, saved.routing.architectureAssessment.summary);
});
