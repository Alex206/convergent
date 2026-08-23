'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const packageJson = require('../../package.json');
const { isWithin, riskyCommand } = require('../copilot/permissions');
const { HeadlessWorkflowUi } = require('./ui');
const { resolveHeadlessRoleModels, assertHeadlessRoleModels } = require('./model-policy');

const execFileAsync = promisify(execFile);
const VALID_FLOWS = new Set(['fast', 'auto', 'thorough']);
const STRUCTURED_REPORT_TOOLS = new Set(['report_plan', 'report_pass', 'report_review', 'report_recovery']);

function extractBenchmarkPrompt(text) {
  const source = String(text ?? '');
  const promptSection = /(?:^|\n)##\s+Prompt\s*\n([\s\S]*?)(?=\n##\s+|$)/i.exec(source)?.[1] ?? source;
  const fenced = /```(?:text|markdown)?\s*\n([\s\S]*?)```/i.exec(promptSection);
  return String(fenced?.[1] ?? promptSection).trim();
}

function defaultMaxModelCalls(flow) {
  if (flow === 'fast') return 24;
  if (flow === 'thorough') return 120;
  return 60;
}

function defaultMaxModelCallsPerTurn(flow) {
  if (flow === 'fast') return 10;
  if (flow === 'thorough') return 40;
  return 20;
}

function defaultMaxChatRequests(flow) {
  if (flow === 'fast') return 8;
  if (flow === 'thorough') return 48;
  return 24;
}

function eventToolKey(event = {}) {
  const sessionId = String(event.sessionId ?? '');
  const toolCallId = String(event?.data?.toolCallId ?? '');
  return sessionId && toolCallId ? `${sessionId}\0${toolCallId}` : '';
}

function acceptedStructuredToolResult(event = {}) {
  const raw = event?.data?.result?.content ?? event?.data?.result?.detailedContent;
  if (raw && typeof raw === 'object') return raw.accepted === true;
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    return JSON.parse(raw).accepted === true;
  } catch {
    return false;
  }
}

function createModelCallBudget({ maxTotalCalls, maxCallsPerTurn, maxChatRequests, onExceeded, onTurnLimit } = {}) {
  const totalLimit = Math.max(1, Math.floor(Number(maxTotalCalls) || 1));
  const turnLimit = Math.max(1, Math.floor(Number(maxCallsPerTurn) || 1));
  const configuredChatLimit = Number(maxChatRequests);
  const chatLimit = Number.isFinite(configuredChatLimit) && configuredChatLimit > 0
    ? Math.max(1, Math.floor(configuredChatLimit))
    : Number.POSITIVE_INFINITY;
  const turnCalls = new Map();
  const pendingTurnLimits = new Map();
  const gracefulTurnStops = new Map();
  const acceptedReports = new Map();
  const activeTools = new Map();
  const turnLimitStops = [];
  let totalCalls = 0;
  let chatStartUsed = null;
  let chatLastUsed = null;
  let chatRequestsUsed = 0;
  let pendingHardLimit = null;
  let breach = null;

  const exceed = (next) => {
    if (breach) return;
    breach = next;
    pendingHardLimit = null;
    pendingTurnLimits.clear();
    onExceeded?.(next);
  };

  const hardBoundary = (event, boundary) => {
    if (!pendingHardLimit || breach) return false;
    exceed({
      ...pendingHardLimit,
      boundary,
      sessionId: event.sessionId ?? pendingHardLimit.sessionId,
    });
    return true;
  };

  const turnBoundary = (event, boundary, toolName = null) => {
    if (breach) return false;
    const agent = String(event.agent ?? 'unknown');
    const pending = pendingTurnLimits.get(agent);
    if (!pending) return false;
    pendingTurnLimits.delete(agent);
    exceed({
      ...pending,
      boundary,
      sessionId: event.sessionId ?? pending.sessionId,
      ...(toolName ? { toolName } : {}),
    });
    return true;
  };

  const stopTurnGracefully = (agent, pending, event, toolName, boundary) => {
    pendingTurnLimits.delete(agent);
    const stop = {
      ...pending,
      boundary,
      sessionId: event.sessionId ?? pending.sessionId,
      toolName,
    };
    gracefulTurnStops.set(agent, stop);
    turnLimitStops.push(stop);
    onTurnLimit?.(stop);
  };

  return {
    handle(event = {}) {
      const agent = String(event.agent ?? 'unknown');
      if (event.type === 'prompt_send') {
        turnCalls.set(agent, 0);
        pendingTurnLimits.delete(agent);
        gracefulTurnStops.delete(agent);
        acceptedReports.delete(agent);
        return;
      }
      if (breach) return;

      if (event.type === 'tool_start') {
        const key = eventToolKey(event);
        if (key) activeTools.set(key, String(event.tool ?? event?.data?.toolName ?? '').split(':').pop());
        return;
      }

      if (event.type === 'tool_complete') {
        const key = eventToolKey(event);
        const toolName = key ? activeTools.get(key) : null;
        if (key) activeTools.delete(key);

        if (hardBoundary(event, 'tool_complete')) return;

        const acceptedReport = STRUCTURED_REPORT_TOOLS.has(toolName) && acceptedStructuredToolResult(event);
        if (acceptedReport) {
          acceptedReports.set(agent, { sessionId: event.sessionId, toolName });
        }

        const pending = pendingTurnLimits.get(agent);
        if (!pending) return;
        if (acceptedReport) {
          stopTurnGracefully(agent, pending, event, toolName, 'accepted_report');
          return;
        }
        turnBoundary(event, 'tool_complete', toolName);
        return;
      }

      if (event.type === 'assistant_turn_end') {
        if (hardBoundary(event, 'assistant_turn_end')) return;
        turnBoundary(event, 'assistant_turn_end');
        return;
      }

      if (event.type === 'assistant_turn_start') {
        const graceful = gracefulTurnStops.get(agent);
        if (graceful) {
          onTurnLimit?.({ ...graceful, boundary: 'post_report_turn_start' });
        }
        return;
      }

      if (event.type !== 'assistant_usage') return;

      totalCalls += 1;
      const currentTurnCalls = (turnCalls.get(agent) ?? 0) + 1;
      turnCalls.set(agent, currentTurnCalls);

      const quotaUsed = Number(event?.data?.quotaSnapshots?.chat?.usedRequests);
      if (Number.isFinite(quotaUsed)) {
        if (chatStartUsed === null || quotaUsed < chatStartUsed) chatStartUsed = quotaUsed;
        chatLastUsed = quotaUsed;
        chatRequestsUsed = Math.max(0, quotaUsed - chatStartUsed);
      }

      if (Number.isFinite(chatLimit) && chatRequestsUsed > chatLimit) {
        exceed({
          kind: 'chat_requests',
          agent,
          calls: chatRequestsUsed,
          limit: chatLimit,
          totalCalls,
          accountUsedRequests: quotaUsed,
          accountStartUsedRequests: chatStartUsed,
          boundary: 'assistant_usage_overrun',
          sessionId: event.sessionId,
        });
        return;
      }
      if (totalCalls > totalLimit) {
        exceed({
          kind: 'run',
          agent,
          calls: totalCalls,
          limit: totalLimit,
          turnCalls: currentTurnCalls,
          chatRequestsUsed,
          boundary: 'assistant_usage_overrun',
          sessionId: event.sessionId,
        });
        return;
      }
      if (currentTurnCalls > turnLimit) {
        exceed({
          kind: 'turn',
          agent,
          calls: currentTurnCalls,
          limit: turnLimit,
          totalCalls,
          chatRequestsUsed,
          boundary: 'assistant_usage_overrun',
          sessionId: event.sessionId,
        });
        return;
      }

      if (!pendingHardLimit && Number.isFinite(chatLimit) && chatRequestsUsed === chatLimit) {
        pendingHardLimit = {
          kind: 'chat_requests',
          agent,
          calls: chatRequestsUsed,
          limit: chatLimit,
          totalCalls,
          accountUsedRequests: quotaUsed,
          accountStartUsedRequests: chatStartUsed,
          sessionId: event.sessionId,
        };
      }
      if (!pendingHardLimit && totalCalls === totalLimit) {
        pendingHardLimit = {
          kind: 'run',
          agent,
          calls: totalCalls,
          limit: totalLimit,
          turnCalls: currentTurnCalls,
          chatRequestsUsed,
          sessionId: event.sessionId,
        };
      }
      if (currentTurnCalls === turnLimit) {
        const pending = {
          kind: 'turn',
          agent,
          calls: currentTurnCalls,
          limit: turnLimit,
          totalCalls,
          chatRequestsUsed,
          sessionId: event.sessionId,
        };
        const acceptedReport = acceptedReports.get(agent);
        const sameSession = acceptedReport
          && (!acceptedReport.sessionId || !event.sessionId || acceptedReport.sessionId === event.sessionId);
        if (sameSession) {
          stopTurnGracefully(agent, pending, event, acceptedReport.toolName, 'accepted_report_usage');
        } else {
          pendingTurnLimits.set(agent, pending);
        }
      }
    },
    snapshot() {
      return {
        totalCalls,
        maxTotalCalls: totalLimit,
        maxCallsPerTurn: turnLimit,
        maxChatRequests: Number.isFinite(chatLimit) ? chatLimit : null,
        chatStartUsed,
        chatLastUsed,
        chatRequestsUsed,
        turnCalls: Object.fromEntries(turnCalls),
        pendingHardLimit,
        pendingTurnLimits: Object.fromEntries(pendingTurnLimits),
        turnLimitStops,
        breach,
      };
    },
  };
}

function parseArgs(argv = []) {
  const result = {
    flow: 'fast',
    coordinator: 'strong',
    workerA: 'adaptive',
    workerB: 'adaptive-diverse',
    reviewer: 'strong',
    routingMode: 'adaptive',
    reasoningMode: 'adaptive',
    maxWorkerPasses: 8,
    maxReviewerCycles: 3,
    maxAiCredits: 0,
    taskCommitMode: 'off',
    auditLevel: 'full',
    limitPolicy: 'pause',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [rawKey, inline] = token.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined || String(value).startsWith('--')) throw new Error(`Missing value for --${rawKey}`);
    result[key] = value;
  }
  result.workspace = result.workspace ? path.resolve(result.workspace) : undefined;
  result.promptFile = result.promptFile ? path.resolve(result.promptFile) : undefined;
  result.outputDir = result.outputDir ? path.resolve(result.outputDir) : undefined;
  result.flow = String(result.flow).toLowerCase();
  if (!VALID_FLOWS.has(result.flow)) throw new Error(`Unsupported flow: ${result.flow}`);
  for (const key of ['maxWorkerPasses', 'maxReviewerCycles', 'maxAiCredits']) result[key] = Number(result[key]);
  const configuredModelCalls = Number(result.maxModelCalls);
  result.maxModelCalls = Number.isFinite(configuredModelCalls) && configuredModelCalls > 0
    ? Math.max(1, Math.floor(configuredModelCalls))
    : defaultMaxModelCalls(result.flow);
  const configuredTurnCalls = Number(result.maxModelCallsPerTurn);
  result.maxModelCallsPerTurn = Number.isFinite(configuredTurnCalls) && configuredTurnCalls > 0
    ? Math.max(1, Math.floor(configuredTurnCalls))
    : defaultMaxModelCallsPerTurn(result.flow);
  const configuredChatRequests = Number(result.maxChatRequests);
  result.maxChatRequests = Number.isFinite(configuredChatRequests) && configuredChatRequests > 0
    ? Math.max(1, Math.floor(configuredChatRequests))
    : defaultMaxChatRequests(result.flow);
  if (!result.workspace) throw new Error('--workspace is required.');
  if (!result.prompt && !result.promptFile) throw new Error('--prompt or --prompt-file is required.');
  if (result.promptFile && !isWithin(result.workspace, result.promptFile)) throw new Error('--prompt-file must be inside --workspace for a reproducible benchmark run.');
  if (!result.outputDir) throw new Error('--output-dir is required and must be outside the target workspace.');
  if (isWithin(result.workspace, result.outputDir)) throw new Error('--output-dir must be outside --workspace so audit artifacts cannot change the task workspace fingerprint.');
  result.auditLevel = result.auditLevel === 'metadata' ? 'metadata' : 'full';
  result.limitPolicy = result.limitPolicy === 'continue' ? 'continue' : 'pause';
  return result;
}

async function readPrompt(options) {
  if (options.prompt) return String(options.prompt).trim();
  return extractBenchmarkPrompt(await fs.readFile(options.promptFile, 'utf8'));
}

function createHeadlessPermissionHandler(workspace, { allowRisky = false, logger = console } = {}) {
  return async (request = {}) => {
    const approve = () => ({ kind: 'approve-once' });
    const deny = () => ({ kind: 'deny' });
    if (request.kind === 'read') return approve();
    if (request.kind === 'write') {
      const target = request.fileName ?? request.path;
      if (!target || !isWithin(workspace, target)) {
        logger?.error?.(`Denied headless write outside workspace: ${target ?? '<unknown>'}`);
        return deny();
      }
      return approve();
    }
    if (request.kind === 'shell') {
      const command = request.fullCommandText ?? '';
      if (!allowRisky && riskyCommand(command)) {
        logger?.error?.(`Denied risky headless shell command: ${command}`);
        return deny();
      }
      return approve();
    }
    return deny();
  };
}

function createScriptedUserInputHandler(answers = [], logger = console) {
  const queue = [...answers].map((value) => String(value));
  return async (request = {}) => {
    if (!queue.length) {
      const error = new Error(`Headless run requires operator input but no scripted answer remains: ${request.question ?? 'unknown question'}`);
      error.code = 'CONVERGENT_HEADLESS_INPUT_REQUIRED';
      throw error;
    }
    const answer = queue.shift();
    logger?.log?.(`Headless scripted operator answer used for: ${request.question ?? 'question'}`);
    return { answer, wasFreeform: !request.choices?.includes(answer) };
  };
}

function answersFromEnvironment(env = process.env) {
  const text = String(env.CONVERGENT_HEADLESS_ANSWERS_JSON ?? '[]').trim() || '[]';
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('CONVERGENT_HEADLESS_ANSWERS_JSON must be a JSON array of strings.');
  return parsed.map(String);
}

async function gitSnapshot(workspace, outputDir) {
  const run = async (...args) => (await execFileAsync('git', ['-C', workspace, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })).stdout;
  const [status, diff, head] = await Promise.all([
    run('status', '--porcelain=v1', '--untracked-files=all'),
    run('diff', '--binary', '--no-ext-diff'),
    run('rev-parse', 'HEAD'),
  ]);
  await fs.writeFile(path.join(outputDir, 'workspace.status'), status, 'utf8');
  await fs.writeFile(path.join(outputDir, 'workspace.diff'), diff, 'utf8');
  return { head: head.trim(), status };
}

async function runHeadless(options, dependencies = {}) {
  const { flowPolicy } = require('../orchestrator/flow');
  const { TrajectoryAudit } = require('../orchestrator/audit');
  const { RecoveryConvergentEngine } = require('../orchestrator/recovery-engine');
  const { createClientOptions } = require('../copilot/runtime');
  const { isWorkflowPausedError } = require('../orchestrator/control');

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
      `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        selectors: { coordinator: options.coordinator, workerA: options.workerA, workerB: options.workerB, reviewer: options.reviewer },
        availableCount: resolution.available.length,
        available: resolution.available,
        resolved: { coordinator: resolution.coordinator, reviewer: resolution.reviewer },
        issues: resolution.issues,
      }, null, 2)}\n`,
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
  const audit = new TrajectoryAudit({ rootDir: path.join(options.outputDir, 'audit'), enabled: true, level: options.auditLevel, maxRuns: 4, maxSizeMB: 500, maxAgeDays: 30 });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-headless`;
  const auditDir = await audit.start({ runId, convergentVersion: packageJson.version, workspace: options.workspace, flowMode: flow.mode, flowPolicy: flow, request: prompt, runtimeTransport: runtime.transport, modelSelectors: { coordinator: options.coordinator, workerA: options.workerA, workerB: options.workerB, reviewer: options.reviewer }, resolvedRoleModels: { coordinator: resolution.coordinator, reviewer: resolution.reviewer }, headless: true, maxModelCalls: options.maxModelCalls, maxModelCallsPerTurn: options.maxModelCallsPerTurn, maxChatRequests: options.maxChatRequests });
  const checkpointPath = path.join(options.outputDir, 'checkpoint.json');
  const controller = new AbortController();
  let engine = null;
  let budgetExceeded = null;

  const budget = createModelCallBudget({
    maxTotalCalls: options.maxModelCalls,
    maxCallsPerTurn: options.maxModelCallsPerTurn,
    maxChatRequests: options.maxChatRequests,
    onTurnLimit: (stop) => {
      const message = `Headless ${stop.agent} turn reached its ${stop.limit}-call cap with an accepted ${stop.toolName}; cancelling only post-report SDK continuation.`;
      console.error(message);
      void audit.record({ type: 'headless_turn_limit_report_complete', ...stop, message });
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
      const message = `Headless budget reached for ${scope} (${breach.calls}/${breach.limit}) after the limit call finished its selected action; aborting active Copilot sessions before another model continuation.`;
      console.error(message);
      void audit.record({ type: 'headless_budget_exceeded', ...breach, message });
      controller.abort();
      void engine?.stop?.();
    },
  });

  const ui = new HeadlessWorkflowUi({
    eventSink: (event) => {
      void audit.record(event);
      budget.handle(event);
    },
    limitPolicy: options.limitPolicy,
  });
  ui.agentInactivityTimeoutMs = 180_000;
  ui.toolStallTimeoutMs = 120_000;
  ui.stallGraceMs = 10_000;
  ui.heartbeatMs = 30_000;
  ui.runStarted({ version: packageJson.version, flowMode: flow.mode, flowLabel: flow.label, headless: true });

  engine = new RecoveryConvergentEngine({
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
    onCheckpoint: async (state) => fs.writeFile(checkpointPath, `${JSON.stringify({ ...state, flowMode: flow.mode }, null, 2)}\n`, 'utf8'),
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
      errorText = `Headless budget was reached for ${scope} (${budgetExceeded.calls}/${budgetExceeded.limit}).`;
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
    await audit.finish({ status, usage, stats: engine.stats, error: errorText, budget: budgetState });
    await fs.writeFile(path.join(options.outputDir, 'result.json'), `${JSON.stringify({ convergentVersion: packageJson.version, status, flow: flow.mode, promptFile: options.promptFile ?? null, auditDir, usage, stats: engine.stats, workspace, plan: result?.plan ?? null, error: errorText, maxModelCalls: options.maxModelCalls, maxModelCallsPerTurn: options.maxModelCallsPerTurn, maxChatRequests: options.maxChatRequests, budget: budgetState }, null, 2)}\n`, 'utf8');
    await engine.stop().catch(() => {});
    if (ownsClient) await client.stop().catch(() => {});
  }
}

module.exports = {
  VALID_FLOWS,
  STRUCTURED_REPORT_TOOLS,
  extractBenchmarkPrompt,
  defaultMaxModelCalls,
  defaultMaxModelCallsPerTurn,
  defaultMaxChatRequests,
  eventToolKey,
  acceptedStructuredToolResult,
  createModelCallBudget,
  parseArgs,
  readPrompt,
  createHeadlessPermissionHandler,
  createScriptedUserInputHandler,
  answersFromEnvironment,
  gitSnapshot,
  runHeadless,
};
