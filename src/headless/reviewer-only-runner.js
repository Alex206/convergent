'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const packageJson = require('../../package.json');
const { HeadlessWorkflowUi } = require('./ui');
const {
  createModelCallBudget,
  readPrompt,
  extractBenchmarkPrompt,
  createHeadlessPermissionHandler,
  createScriptedUserInputHandler,
  answersFromEnvironment,
  gitSnapshot,
} = require('./runner');
const { resolveHeadlessRoleModels, assertHeadlessRoleModels } = require('./model-policy');
const { applyTopologySelectors } = require('./topology');
const { UsageTracker } = require('../orchestrator/usage');
const { flowPolicy, reviewerFlowInstructions } = require('../orchestrator/flow');
const { TrajectoryAudit } = require('../orchestrator/audit');
const { createClientOptions } = require('../copilot/runtime');
const { workspaceRevision, assertGitRepository } = require('../orchestrator/revision');
const { workspaceScopePrompt } = require('../orchestrator/workspace-scope');
const { chooseReasoningEffort } = require('../orchestrator/routing');
const { requireReport } = require('../orchestrator/engine');
const { createReviewTool } = require('../copilot/tools');
const {
  SessionFactory,
  attachEventLogging,
  readonlyHook,
  safeSessionPart,
  withReasoning,
  REVIEWER_TOOLS,
} = require('../copilot/session-factory');
const {
  SPECIALIZED_PARTITIONS,
  broadReviewPrompt,
  specializedReviewPrompt,
  reviewArmConfig,
} = require('./equalized-review-protocols');

class EqualizedReviewSessionFactory extends SessionFactory {
  async createBenchmarkReviewer(taskId, reviewerId, label, model, systemPromptContent) {
    const safeTaskId = safeSessionPart(taskId);
    const safeReviewerId = safeSessionPart(reviewerId);
    const sink = { value: null };
    const tool = createReviewTool(this.sdk.defineTool, sink);
    const batchView = this.batchViewTool();
    const name = `Reviewer ${label}`;
    let guard = null;
    const runCommand = this.runCommandTool(name, () => guard);
    const effort = chooseReasoningEffort(model, 'medium', this.reasoningMode);
    const baselinePrompt = await this.taskBaselinePrompt(taskId);
    const systemPrompt = [
      systemPromptContent,
      reviewerFlowInstructions(this.flowMode),
      this.explorationPrompt(),
      workspaceScopePrompt(this.workspace, this.workspaceFolders),
      baselinePrompt,
    ].filter(Boolean).join('\n\n');

    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-${safeReviewerId}`,
      clientName: 'convergent-reviewer-only-benchmark',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [batchView, runCommand, tool],
      availableTools: REVIEWER_TOOLS,
      customAgents: [this.exploreAgent()],
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: { onPreToolUse: (input) => this.preToolUse(readonlyHook, name, input) },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));

    guard = this.guard(session, name);
    const usageKey = `${safeTaskId}:${safeReviewerId}`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey, {
      sink,
      toolName: 'report_review',
    });
    this.ui.agentTools?.(name, REVIEWER_TOOLS);
    this.sessionCreated(name, session, model, effort, systemPrompt, REVIEWER_TOOLS, {
      role: 'reviewer-only-benchmark',
      taskId: safeTaskId,
      reviewerId,
      benchmarkOnly: true,
    });

    return {
      session,
      guard,
      sink,
      name,
      reviewerId,
      label,
      usageName: usageKey,
      model,
      reasoningEffort: effort,
      systemPrompt,
    };
  }
}

function resolvedModelsJson(options, resolution, armConfig) {
  return {
    generatedAt: new Date().toISOString(),
    reviewArm: armConfig.arm,
    reviewArmLabel: armConfig.label,
    selectors: {
      workerA: options.workerA,
      reviewer: options.reviewer,
    },
    availableCount: resolution.available.length,
    available: resolution.available,
    resolved: {
      terra: resolution.reviewer,
      lunaSelector: options.workerA,
    },
    issues: resolution.issues,
  };
}

function reviewerTaskPrompt(taskRequest, label) {
  return [
    'FROZEN REVIEW CASE',
    '',
    'The repository already contains the implementation to review. Do not implement, remediate, or edit anything.',
    'The snapshot may be correct or defective. Judge only from the task contract and repository evidence.',
    '',
    'Original task request:',
    taskRequest,
    '',
    `Reviewer assignment: ${label}.`,
    'Perform exactly one independent review pass. Call report_review exactly once.',
  ].join('\n');
}

async function runReviewerOnlyHeadless(rawOptions, dependencies = {}) {
  const armConfig = reviewArmConfig(rawOptions.arm);
  const options = applyTopologySelectors({
    ...rawOptions,
    topology: 'luna-terra-structured',
  });

  await fs.mkdir(options.outputDir, { recursive: true });
  const rawPrompt = await readPrompt(options);
  const taskRequest = extractBenchmarkPrompt(rawPrompt);
  if (!taskRequest) throw new Error('Reviewer-only benchmark prompt is empty.');
  await assertGitRepository(options.workspace);

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
      `${JSON.stringify(resolvedModelsJson(options, resolution, armConfig), null, 2)}\n`,
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
    request: taskRequest,
    runtimeTransport: runtime.transport,
    benchmarkTopology: armConfig.arm,
    benchmarkTopologyLabel: armConfig.label,
    reviewerOnly: true,
    equalizedInstructions: true,
    resolvedRoleModels: {
      reviewer: resolution.reviewer,
      workers: resolution.workers,
    },
    headless: true,
    maxModelCalls: options.maxModelCalls,
    maxModelCallsPerTurn: options.maxModelCallsPerTurn,
    maxChatRequests: options.maxChatRequests,
  });

  const usage = new UsageTracker();
  const sessions = [];
  let budgetExceeded = null;
  const budget = createModelCallBudget({
    maxTotalCalls: options.maxModelCalls,
    maxCallsPerTurn: options.maxModelCallsPerTurn,
    maxChatRequests: options.maxChatRequests,
    onTurnLimit: (stop) => {
      const session = sessions.find((candidate) => candidate?.sessionId === stop.sessionId);
      void session?.abort?.().catch(() => {});
    },
    onExceeded: (breach) => {
      budgetExceeded = breach;
      for (const session of sessions) void session?.abort?.().catch(() => {});
    },
  });

  const ui = new HeadlessWorkflowUi({
    eventSink: (event) => {
      void audit.record({ topology: armConfig.arm, ...event });
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
    headless: true,
    topology: armConfig.arm,
  });

  const factory = new EqualizedReviewSessionFactory({
    client,
    sdk,
    workspace: options.workspace,
    models,
    permissionHandler: createHeadlessPermissionHandler(options.workspace),
    userInputHandler: createScriptedUserInputHandler(answers),
    ui,
    usage,
    runId,
    reasoningMode: options.reasoningMode,
  });

  const taskId = 'frozen-review-case';
  const reviewers = [];
  if (armConfig.modelFamily === 'terra') {
    reviewers.push(await factory.createBenchmarkReviewer(
      taskId,
      'terra-broad',
      'Terra broad',
      resolution.reviewer,
      broadReviewPrompt(),
    ));
  } else if (!armConfig.specialization) {
    for (let index = 0; index < armConfig.reviewerCount; index += 1) {
      const model = factory.workerModel(`${taskId}-broad-${index + 1}`, 'A', 'standard', 'medium');
      reviewers.push(await factory.createBenchmarkReviewer(
        taskId,
        `luna-broad-${index + 1}`,
        `Luna broad ${index + 1}`,
        model,
        broadReviewPrompt(),
      ));
    }
  } else {
    if (armConfig.reviewerCount !== SPECIALIZED_PARTITIONS.length) {
      throw new Error(`Specialized reviewer count ${armConfig.reviewerCount} does not match ${SPECIALIZED_PARTITIONS.length} fixed partitions.`);
    }
    for (let index = 0; index < SPECIALIZED_PARTITIONS.length; index += 1) {
      const partition = SPECIALIZED_PARTITIONS[index];
      const model = factory.workerModel(`${taskId}-specialized-${index + 1}`, 'A', 'standard', 'medium');
      reviewers.push(await factory.createBenchmarkReviewer(
        taskId,
        `luna-specialized-${partition.id}`,
        `Luna specialized ${partition.label}`,
        model,
        specializedReviewPrompt(partition),
      ));
    }
  }
  sessions.push(...reviewers.map((entry) => entry.session));

  const initialRevision = await workspaceRevision(options.workspace);
  const reports = [];
  let status = 'failed';
  let errorText = null;

  try {
    for (const reviewer of reviewers) {
      if (budgetExceeded) throw new Error(`Reviewer-only budget exceeded: ${budgetExceeded.kind}`);
      const before = await workspaceRevision(options.workspace);
      const startedAt = Date.now();
      reviewer.sink.value = null;
      const report = await requireReport(
        reviewer.session,
        reviewer.sink,
        reviewerTaskPrompt(taskRequest, reviewer.label),
        'report_review',
        180_000,
      );
      const durationMs = Date.now() - startedAt;
      usage.recordTurn(reviewer.usageName, durationMs);
      await usage.refresh(reviewer.usageName, reviewer.session);
      const after = await workspaceRevision(options.workspace);
      if (before !== after) {
        throw new Error(`${reviewer.name} changed the frozen workspace despite the read-only contract.`);
      }
      const normalized = {
        reviewerId: reviewer.reviewerId,
        label: reviewer.label,
        modelId: reviewer.model?.id ?? null,
        modelName: reviewer.model?.name ?? reviewer.model?.id ?? null,
        verdict: report.verdict,
        summary: report.summary ?? '',
        findings: report.findings ?? [],
        checks: report.checks ?? [],
        durationMs,
      };
      reports.push(normalized);
      await audit.record({ type: 'reviewer_only_result', arm: armConfig.arm, ...normalized });
    }
    const finalRevision = await workspaceRevision(options.workspace);
    if (initialRevision !== finalRevision) throw new Error('Frozen reviewer-only workspace changed during the benchmark.');
    status = 'complete';
    return { reports, usage: usage.summary() };
  } catch (error) {
    errorText = error?.message ?? String(error);
    throw error;
  } finally {
    const usageSummary = usage.summary();
    const workspace = await gitSnapshot(options.workspace, options.outputDir).catch((error) => ({ error: error.message }));
    const budgetState = budget.snapshot();
    await audit.finish({
      status,
      topology: armConfig.arm,
      reviewerOnly: true,
      reports,
      usage: usageSummary,
      error: errorText,
      budget: budgetState,
    });
    await fs.writeFile(
      path.join(options.outputDir, 'reviewer-only-result.json'),
      `${JSON.stringify({
        convergentVersion: packageJson.version,
        status,
        arm: armConfig.arm,
        armLabel: armConfig.label,
        reviewerOnly: true,
        equalizedInstructions: true,
        promptFile: options.promptFile ?? null,
        auditDir,
        reports,
        usage: usageSummary,
        workspace,
        error: errorText,
        budget: budgetState,
      }, null, 2)}\n`,
      'utf8',
    );
    if (ownsClient) await client.stop().catch(() => {});
  }
}

module.exports = {
  EqualizedReviewSessionFactory,
  resolvedModelsJson,
  reviewerTaskPrompt,
  runReviewerOnlyHeadless,
};
