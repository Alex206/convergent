'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const packageJson = require('../../package.json');
const { HeadlessWorkflowUi } = require('./ui');
const {
  createModelCallBudget,
  readPrompt,
  createHeadlessPermissionHandler,
  createScriptedUserInputHandler,
  answersFromEnvironment,
  gitSnapshot,
} = require('./runner');
const { resolveHeadlessRoleModels, assertHeadlessRoleModels } = require('./model-policy');
const { applyTopologySelectors, topologyConfig } = require('./topology');
const { BenchmarkTopologyEngine } = require('./topology-engine');
const { PerspectivePanelTopologyEngine } = require('./perspective-topology-engine');
const { runSingleAgentBaseline } = require('./single-agent-baseline');
const { UsageTracker } = require('../orchestrator/usage');
const { flowPolicy } = require('../orchestrator/flow');
const { TrajectoryAudit } = require('../orchestrator/audit');
const { createClientOptions } = require('../copilot/runtime');
const { isWorkflowPausedError } = require('../orchestrator/control');

function resolvedModelsJson(options, resolution, topology) {
  return {
    generatedAt: new Date().toISOString(),
    topology,
    selectors: {
      coordinator: options.coordinator,
      workerA: options.workerA,
      workerB: options.workerB,
      reviewer: options.reviewer,
    },
    availableCount: resolution.available.length,
    available: resolution.available,
    resolved: {
      coordinator: resolution.coordinator,
      reviewer: resolution.reviewer,
      workers: resolution.workers,
    },
    issues: resolution.issues,
  };
}

async function runTopologyHeadless(rawOptions, dependencies = {}) {
  const options = applyTopologySelectors(rawOptions);
  const topology = options.topology;
  const topologySpec = topologyConfig(topology);

  await fs.mkdir(options.outputDir, { recursive: true });
  const prompt = await readPrompt(options);
  if (!prompt) throw new Error('Benchmark prompt is empty.');

  const answers = dependencies.answers ?? answersFromEnvironment(dependencies.env ?? process.env);
  const sdk = dependencies.sdk ?? await import('@github/copilot-sdk');
  const runtime = createClientOptions(sdk, 'stdio', process.execPath);
  const client = dependencies.client ?? new sdk.CopilotClient(runtime.options);
  const ownsClient = !dependencies.client;
  if (ownsClient) await client.start();

  const flow = flowPolicy(options.flow, options);
  let resolution;
  try {
    const available = await client.listModels();
    resolution = resolveHeadlessRoleModels(options, available);
    await fs.writeFile(
      path.join(options.outputDir, 'models.json'),
      `${JSON.stringify(resolvedModelsJson(options, resolution, topology), null, 2)}\n`,
      'utf8',
    );
    assertHeadlessRoleModels(resolution);
  } catch (error) {
    if (ownsClient) await client.stop().catch(() => {});
    throw error;
  }

  const models = {
    coordinator: resolution.coordinator,
    reviewer: resolution.reviewer,
    workerASelector: options.workerA,
    workerBSelector: options.workerB,
    available: resolution.available,
    flowMode: flow.mode,
  };

  const audit = new TrajectoryAudit({
    rootDir: path.join(options.outputDir, 'audit'),
    enabled: true,
    level: options.auditLevel,
    maxRuns: 4,
    maxSizeMB: 500,
    maxAgeDays: 30,
  });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${topology}`;
  const auditDir = await audit.start({
    runId,
    convergentVersion: packageJson.version,
    workspace: options.workspace,
    flowMode: flow.mode,
    flowPolicy: flow,
    request: prompt,
    runtimeTransport: runtime.transport,
    benchmarkTopology: topology,
    benchmarkTopologyLabel: topologySpec.label,
    modelSelectors: {
      coordinator: options.coordinator,
      workerA: options.workerA,
      workerB: options.workerB,
      reviewer: options.reviewer,
    },
    resolvedRoleModels: {
      coordinator: resolution.coordinator,
      reviewer: resolution.reviewer,
      workers: resolution.workers,
    },
    headless: true,
    maxModelCalls: options.maxModelCalls,
    maxModelCallsPerTurn: options.maxModelCallsPerTurn,
    maxChatRequests: options.maxChatRequests,
  });

  const checkpointPath = path.join(options.outputDir, 'checkpoint.json');
  const controller = new AbortController();
  let engine = null;
  let baseline = null;
  let usageTracker = null;
  let budgetExceeded = null;
  let stopActive = async () => {};

  const budget = createModelCallBudget({
    maxTotalCalls: options.maxModelCalls,
    maxCallsPerTurn: options.maxModelCallsPerTurn,
    maxChatRequests: options.maxChatRequests,
    onTurnLimit: (stop) => {
      const message = `Topology benchmark ${stop.agent} turn reached its ${stop.limit}-call cap with an accepted ${stop.toolName ?? 'report'}; stopping post-report continuation.`;
      console.error(message);
      void audit.record({ type: 'headless_turn_limit_report_complete', topology, ...stop, message });
      if (engine) {
        const session = engine.sessions?.find((candidate) => candidate?.sessionId === stop.sessionId);
        void session?.abort?.().catch(() => {});
      }
    },
    onExceeded: (breach) => {
      budgetExceeded = breach;
      const message = `Topology benchmark budget reached (${breach.kind}: ${breach.calls}/${breach.limit}); aborting active agent sessions.`;
      console.error(message);
      void audit.record({ type: 'headless_budget_exceeded', topology, ...breach, message });
      controller.abort();
      void stopActive();
    },
  });

  const ui = new HeadlessWorkflowUi({
    eventSink: (event) => {
      const enriched = { topology, ...event };
      void audit.record(enriched);
      budget.handle(enriched);
    },
    limitPolicy: options.limitPolicy,
  });
  ui.agentInactivityTimeoutMs = 180_000;
  ui.toolStallTimeoutMs = 120_000;
  ui.stallGraceMs = 10_000;
  ui.heartbeatMs = 30_000;
  ui.runStarted({
    version: packageJson.version,
    flowMode: flow.mode,
    flowLabel: flow.label,
    headless: true,
    topology,
  });

  const permissionHandler = createHeadlessPermissionHandler(options.workspace);
  const userInputHandler = createScriptedUserInputHandler(answers);

  if (topologySpec.kind === 'single_agent') {
    usageTracker = new UsageTracker();
    baseline = await runSingleAgentBaseline({
      client,
      sdk,
      workspace: options.workspace,
      models,
      permissionHandler,
      userInputHandler,
      ui,
      usage: usageTracker,
      runId,
      reasoningMode: options.reasoningMode,
    });
    stopActive = () => baseline.stop();
  } else {
    const EngineClass = topologySpec.panelMode
      ? PerspectivePanelTopologyEngine
      : BenchmarkTopologyEngine;
    engine = new EngineClass({
      client,
      sdk,
      workspace: options.workspace,
      models,
      permissionHandler,
      userInputHandler,
      ui,
      maxWorkerPasses: flow.maxWorkerPasses,
      maxReviewerCycles: flow.maxReviewerCycles,
      maxAiCredits: options.maxAiCredits,
      taskCommitMode: options.taskCommitMode,
      routingMode: options.routingMode,
      reasoningMode: options.reasoningMode,
      signal: controller.signal,
      topology,
      maxPeerCriticCycles: options.maxPeerCriticCycles,
      onCheckpoint: async (state) => fs.writeFile(
        checkpointPath,
        `${JSON.stringify({ ...state, flowMode: flow.mode, topology }, null, 2)}\n`,
        'utf8',
      ),
    });
    stopActive = () => engine.stop();
  }

  let status = 'failed';
  let errorText = null;
  let result = null;
  let stats = null;

  try {
    if (baseline) {
      const baselineResult = await baseline.run(prompt);
      result = { plan: null, usage: baselineResult.usage, stats: baselineResult.stats };
      stats = baselineResult.stats;
    } else {
      result = await engine.run(prompt);
      stats = engine.stats;
    }
    status = 'complete';
    return result;
  } catch (error) {
    if (budgetExceeded) {
      status = 'budget_exceeded';
      errorText = `Topology benchmark budget was reached for ${budgetExceeded.kind} (${budgetExceeded.calls}/${budgetExceeded.limit}).`;
      const budgetError = new Error(errorText);
      budgetError.code = budgetExceeded.kind === 'chat_requests'
        ? 'CONVERGENT_HEADLESS_CHAT_REQUEST_BUDGET'
        : 'CONVERGENT_HEADLESS_MODEL_CALL_BUDGET';
      budgetError.budget = budgetExceeded;
      throw budgetError;
    }
    errorText = error?.message ?? String(error);
    if (isWorkflowPausedError(error)) status = 'paused';
    throw error;
  } finally {
    const usage = engine
      ? engine.getUsageSummary()
      : usageTracker?.summary() ?? result?.usage ?? {};
    stats = stats ?? engine?.stats ?? result?.stats ?? {};
    const workspace = await gitSnapshot(options.workspace, options.outputDir)
      .catch((error) => ({ error: error.message }));
    const budgetState = budget.snapshot();

    await audit.finish({
      status,
      topology,
      usage,
      stats,
      error: errorText,
      budget: budgetState,
    });
    await fs.writeFile(
      path.join(options.outputDir, 'result.json'),
      `${JSON.stringify({
        convergentVersion: packageJson.version,
        status,
        topology,
        topologyLabel: topologySpec.label,
        flow: flow.mode,
        promptFile: options.promptFile ?? null,
        auditDir,
        usage,
        stats,
        workspace,
        plan: result?.plan ?? null,
        error: errorText,
        maxModelCalls: options.maxModelCalls,
        maxModelCallsPerTurn: options.maxModelCallsPerTurn,
        maxChatRequests: options.maxChatRequests,
        budget: budgetState,
      }, null, 2)}\n`,
      'utf8',
    );

    await stopActive().catch(() => {});
    if (ownsClient) await client.stop().catch(() => {});
  }
}

module.exports = {
  resolvedModelsJson,
  runTopologyHeadless,
};
