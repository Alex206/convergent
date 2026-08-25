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
const { applyTopologySelectors } = require('./topology');
const { PANEL_MODES } = require('./perspective-review-engine');
const { IsolatedPerspectiveReviewEngine } = require('./isolated-perspective-review-engine');
const { flowPolicy } = require('../orchestrator/flow');
const { TrajectoryAudit } = require('../orchestrator/audit');
const { createClientOptions } = require('../copilot/runtime');
const { isWorkflowPausedError } = require('../orchestrator/control');

const REVIEW_ARMS = Object.freeze({
  'generic-luna-panel-terra': Object.freeze({
    label: '3 generic Luna reviewers + Terra adjudication',
    reviewMode: PANEL_MODES.generic,
  }),
  'perspective-luna-terra': Object.freeze({
    label: '3 Terra-selected perspective Luna reviewers + Terra adjudication',
    reviewMode: PANEL_MODES.perspective,
  }),
});

function reviewArmConfig(value) {
  const arm = String(value ?? '').trim().toLowerCase();
  if (!Object.hasOwn(REVIEW_ARMS, arm)) {
    throw new Error(`Unsupported review arm ${JSON.stringify(value)}. Expected one of: ${Object.keys(REVIEW_ARMS).join(', ')}.`);
  }
  return { arm, ...REVIEW_ARMS[arm] };
}

function resolvedModelsJson(options, resolution, arm) {
  return {
    generatedAt: new Date().toISOString(),
    reviewArm: arm,
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

async function runPanelReviewHeadless(rawOptions, dependencies = {}) {
  const armConfig = reviewArmConfig(rawOptions.arm);
  const options = applyTopologySelectors({
    ...rawOptions,
    topology: 'luna-terra-structured',
  });

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
      `${JSON.stringify(resolvedModelsJson(options, resolution, armConfig.arm), null, 2)}\n`,
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
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${armConfig.arm}`;
  const auditDir = await audit.start({
    runId,
    convergentVersion: packageJson.version,
    workspace: options.workspace,
    flowMode: flow.mode,
    flowPolicy: flow,
    request: prompt,
    runtimeTransport: runtime.transport,
    benchmarkTopology: armConfig.arm,
    benchmarkTopologyLabel: armConfig.label,
    reviewMode: armConfig.reviewMode,
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
  let budgetExceeded = null;

  const budget = createModelCallBudget({
    maxTotalCalls: options.maxModelCalls,
    maxCallsPerTurn: options.maxModelCallsPerTurn,
    maxChatRequests: options.maxChatRequests,
    onTurnLimit: (stop) => {
      const message = `Review benchmark ${stop.agent} turn reached its ${stop.limit}-call cap with an accepted ${stop.toolName ?? 'report'}; stopping post-report continuation.`;
      console.error(message);
      void audit.record({ type: 'headless_turn_limit_report_complete', topology: armConfig.arm, ...stop, message });
      const session = engine?.sessions?.find((candidate) => candidate?.sessionId === stop.sessionId);
      void session?.abort?.().catch(() => {});
    },
    onExceeded: (breach) => {
      budgetExceeded = breach;
      const message = `Review benchmark budget reached (${breach.kind}: ${breach.calls}/${breach.limit}); aborting active agent sessions.`;
      console.error(message);
      void audit.record({ type: 'headless_budget_exceeded', topology: armConfig.arm, ...breach, message });
      controller.abort();
      void engine?.stop?.();
    },
  });

  const ui = new HeadlessWorkflowUi({
    eventSink: (event) => {
      const enriched = { topology: armConfig.arm, ...event };
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
    topology: armConfig.arm,
  });

  engine = new IsolatedPerspectiveReviewEngine({
    client,
    sdk,
    workspace: options.workspace,
    models,
    permissionHandler: createHeadlessPermissionHandler(options.workspace),
    userInputHandler: createScriptedUserInputHandler(answers),
    ui,
    maxWorkerPasses: flow.maxWorkerPasses,
    maxReviewerCycles: flow.maxReviewerCycles,
    maxAiCredits: options.maxAiCredits,
    taskCommitMode: options.taskCommitMode,
    routingMode: options.routingMode,
    reasoningMode: options.reasoningMode,
    signal: controller.signal,
    reviewMode: armConfig.reviewMode,
    onCheckpoint: async (state) => fs.writeFile(
      checkpointPath,
      `${JSON.stringify({ ...state, flowMode: flow.mode, reviewArm: armConfig.arm }, null, 2)}\n`,
      'utf8',
    ),
  });

  let status = 'failed';
  let errorText = null;
  let result = null;

  try {
    result = await engine.run(prompt);
    status = 'complete';
    return result;
  } catch (error) {
    if (budgetExceeded) {
      status = 'budget_exceeded';
      errorText = `Review benchmark budget was reached for ${budgetExceeded.kind} (${budgetExceeded.calls}/${budgetExceeded.limit}).`;
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
    const usage = engine.getUsageSummary();
    const workspace = await gitSnapshot(options.workspace, options.outputDir)
      .catch((error) => ({ error: error.message }));
    const budgetState = budget.snapshot();
    await audit.finish({
      status,
      topology: armConfig.arm,
      reviewMode: armConfig.reviewMode,
      usage,
      stats: engine.stats,
      error: errorText,
      budget: budgetState,
    });
    await fs.writeFile(
      path.join(options.outputDir, 'result.json'),
      `${JSON.stringify({
        convergentVersion: packageJson.version,
        status,
        topology: armConfig.arm,
        topologyLabel: armConfig.label,
        reviewMode: armConfig.reviewMode,
        flow: flow.mode,
        promptFile: options.promptFile ?? null,
        auditDir,
        usage,
        stats: engine.stats,
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
    await engine.stop().catch(() => {});
    if (ownsClient) await client.stop().catch(() => {});
  }
}

module.exports = {
  REVIEW_ARMS,
  reviewArmConfig,
  resolvedModelsJson,
  runPanelReviewHeadless,
};
