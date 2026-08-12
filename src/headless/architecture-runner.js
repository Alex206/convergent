'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const packageJson = require('../../package.json');
const { flowPolicy } = require('../orchestrator/flow');
const { TrajectoryAudit } = require('../orchestrator/audit');
const { RecoveryConvergentEngine } = require('../orchestrator/recovery-engine');
const { createClientOptions } = require('../copilot/runtime');
const { isWorkflowPausedError } = require('../orchestrator/control');
const { HeadlessWorkflowUi } = require('./ui');
const { resolveHeadlessRoleModels, assertHeadlessRoleModels } = require('./model-policy');
const {
  readPrompt,
  answersFromEnvironment,
  createHeadlessPermissionHandler,
  createScriptedUserInputHandler,
  createModelCallBudget,
  gitSnapshot,
} = require('./runner');
const {
  ARCHITECTURES,
  normalizeArchitecture,
  architectureMetadata,
  ExperimentalTopologyEngine,
} = require('./topologies');

function architectureRelevantModelIssues(architecture, issues = []) {
  const id = normalizeArchitecture(architecture);
  let roles;
  if (id === ARCHITECTURES.SINGLE_AGENT) {
    roles = new Set(['workerA']);
  } else if (id === ARCHITECTURES.IMPLEMENTER_REVIEWER) {
    roles = new Set(['workerA', 'reviewer']);
  } else if (id === ARCHITECTURES.PEER_COMPETITION) {
    roles = new Set(['workerA', 'workerB']);
  } else if (id === ARCHITECTURES.PEER_COMPETITION_REVIEWER) {
    roles = new Set(['workerA', 'workerB', 'reviewer']);
  } else {
    roles = new Set(['coordinator', 'workerA', 'workerB', 'reviewer']);
  }
  return (issues ?? []).filter((issue) => roles.has(issue.role));
}

function assertArchitectureRoleModels(architecture, resolution) {
  const relevant = architectureRelevantModelIssues(architecture, resolution?.issues);
  return assertHeadlessRoleModels({ ...resolution, issues: relevant });
}

function sessionModelRecord(event = {}) {
  if (event.type !== 'session_create') return null;
  return {
    agent: event.agent ?? null,
    role: event.role ?? null,
    taskId: event.taskId ?? null,
    modelId: event.model ?? null,
    modelName: event.modelName ?? null,
    reasoningEffort: event.reasoningEffort ?? null,
    sessionId: event.sessionId ?? null,
  };
}

async function runArchitectureBenchmark(options, dependencies = {}) {
  const architecture = normalizeArchitecture(options.architecture);
  const metadata = architectureMetadata(architecture, options);
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
  let relevantIssues = [];
  try {
    const available = await client.listModels();
    resolution = resolveHeadlessRoleModels(options, available);
    relevantIssues = architectureRelevantModelIssues(architecture, resolution.issues);
    await fs.writeFile(
      path.join(options.outputDir, 'models.json'),
      `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        architecture: metadata,
        selectors: {
          coordinator: options.coordinator,
          workerA: options.workerA,
          workerB: options.workerB,
          reviewer: options.reviewer,
        },
        availableCount: resolution.available.length,
        available: resolution.available,
        resolved: { coordinator: resolution.coordinator, reviewer: resolution.reviewer },
        relevantIssues,
        ignoredUnusedRoleIssues: resolution.issues.filter((issue) => !relevantIssues.includes(issue)),
      }, null, 2)}\n`,
      'utf8',
    );
    assertArchitectureRoleModels(architecture, resolution);
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
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${architecture}`;
  const auditDir = await audit.start({
    runId,
    convergentVersion: packageJson.version,
    workspace: options.workspace,
    flowMode: flow.mode,
    flowPolicy: flow,
    request: prompt,
    runtimeTransport: runtime.transport,
    modelSelectors: {
      coordinator: options.coordinator,
      workerA: options.workerA,
      workerB: options.workerB,
      reviewer: options.reviewer,
    },
    resolvedRoleModels: { coordinator: resolution.coordinator, reviewer: resolution.reviewer },
    architecture: metadata,
    experimentalArchitectureBenchmark: true,
    headless: true,
    maxModelCalls: options.maxModelCalls,
    maxModelCallsPerTurn: options.maxModelCallsPerTurn,
    maxChatRequests: options.maxChatRequests,
  });

  await fs.writeFile(path.join(options.outputDir, 'architecture.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  const checkpointPath = path.join(options.outputDir, 'checkpoint.json');
  const controller = new AbortController();
  const actualRoleModels = [];
  let engine = null;
  let budgetExceeded = null;

  const budget = createModelCallBudget({
    maxTotalCalls: options.maxModelCalls,
    maxCallsPerTurn: options.maxModelCallsPerTurn,
    maxChatRequests: options.maxChatRequests,
    onTurnLimit: (stop) => {
      const message = `Headless ${stop.agent} turn reached its ${stop.limit}-call cap with an accepted ${stop.toolName}; cancelling only post-report SDK continuation.`;
      console.error(message);
      void audit.record({ type: 'headless_turn_limit_report_complete', architecture, ...stop, message });
      const session = engine?.sessions?.find((candidate) => candidate?.sessionId === stop.sessionId);
      void session?.abort?.().catch(() => {});
    },
    onExceeded: (breach) => {
      budgetExceeded = breach;
      const scope = breach.kind === 'turn'
        ? `${breach.agent} agent turn`
        : breach.kind === 'chat_requests'
          ? 'Copilot chat-request quota delta'
          : 'headless run';
      const message = `Headless architecture budget reached for ${scope} (${breach.calls}/${breach.limit}); aborting active Copilot sessions before another model continuation.`;
      console.error(message);
      void audit.record({ type: 'headless_budget_exceeded', architecture, ...breach, message });
      controller.abort();
      void engine?.stop?.();
    },
  });

  const ui = new HeadlessWorkflowUi({
    eventSink: (event) => {
      const sessionModel = sessionModelRecord(event);
      if (sessionModel) actualRoleModels.push(sessionModel);
      void audit.record({ architecture, ...event });
      budget.handle(event);
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
    architecture,
    headless: true,
  });

  const commonEngineOptions = {
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
    onCheckpoint: async (state) => fs.writeFile(
      checkpointPath,
      `${JSON.stringify({ ...state, flowMode: flow.mode, architecture }, null, 2)}\n`,
      'utf8',
    ),
  };

  engine = architecture === ARCHITECTURES.CONVERGENT_V02
    ? new RecoveryConvergentEngine(commonEngineOptions)
    : new ExperimentalTopologyEngine({
      ...commonEngineOptions,
      architecture,
      experimentalRoute: options.experimentalRoute ?? 'standard',
      experimentalRisk: options.experimentalRisk ?? 'medium',
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
      const scope = budgetExceeded.kind === 'turn'
        ? `${budgetExceeded.agent} turn`
        : budgetExceeded.kind === 'chat_requests'
          ? 'Copilot chat-request quota delta'
          : 'run';
      errorText = `Headless architecture budget was reached for ${scope} (${budgetExceeded.calls}/${budgetExceeded.limit}).`;
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
    const workspace = await gitSnapshot(options.workspace, options.outputDir).catch((error) => ({ error: error.message }));
    const budgetState = budget.snapshot();
    await audit.finish({
      status,
      usage,
      stats: engine.stats,
      error: errorText,
      budget: budgetState,
      architecture: metadata,
      actualRoleModels,
    });
    await fs.writeFile(
      path.join(options.outputDir, 'result.json'),
      `${JSON.stringify({
        convergentVersion: packageJson.version,
        status,
        flow: flow.mode,
        architecture: metadata,
        actualRoleModels,
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
  architectureRelevantModelIssues,
  assertArchitectureRoleModels,
  sessionModelRecord,
  runArchitectureBenchmark,
};
