'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const packageJson = require('../../package.json');
const { isWithin, riskyCommand } = require('../copilot/permissions');
const { HeadlessWorkflowUi } = require('./ui');

const execFileAsync = promisify(execFile);
const VALID_FLOWS = new Set(['fast', 'auto', 'thorough']);

function extractBenchmarkPrompt(text) {
  const source = String(text ?? '');
  const promptSection = /(?:^|\n)##\s+Prompt\s*\n([\s\S]*?)(?=\n##\s+|$)/i.exec(source)?.[1] ?? source;
  const fenced = /```(?:text|markdown)?\s*\n([\s\S]*?)```/i.exec(promptSection);
  return String(fenced?.[1] ?? promptSection).trim();
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
  const { resolveModel } = require('../orchestrator/model-resolver');
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
  const available = await client.listModels();
  const models = {
    coordinator: resolveModel(options.coordinator, available),
    reviewer: resolveModel(options.reviewer, available),
    workerASelector: options.workerA,
    workerBSelector: options.workerB,
    available,
    flowMode: flow.mode,
  };
  const audit = new TrajectoryAudit({ rootDir: path.join(options.outputDir, 'audit'), enabled: true, level: options.auditLevel, maxRuns: 4, maxSizeMB: 500, maxAgeDays: 30 });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-headless`;
  const auditDir = await audit.start({ runId, convergentVersion: packageJson.version, workspace: options.workspace, flowMode: flow.mode, flowPolicy: flow, request: prompt, runtimeTransport: runtime.transport, modelSelectors: { coordinator: options.coordinator, workerA: options.workerA, workerB: options.workerB, reviewer: options.reviewer }, headless: true });
  const ui = new HeadlessWorkflowUi({ eventSink: (event) => audit.record(event), limitPolicy: options.limitPolicy });
  ui.agentInactivityTimeoutMs = 180_000;
  ui.toolStallTimeoutMs = 120_000;
  ui.stallGraceMs = 10_000;
  ui.heartbeatMs = 30_000;
  ui.runStarted({ version: packageJson.version, flowMode: flow.mode, flowLabel: flow.label, headless: true });
  const checkpointPath = path.join(options.outputDir, 'checkpoint.json');
  const controller = new AbortController();
  const engine = new RecoveryConvergentEngine({
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
    errorText = error?.message ?? String(error);
    if (isWorkflowPausedError(error)) status = 'paused';
    throw error;
  } finally {
    const usage = engine.getUsageSummary();
    const workspace = await gitSnapshot(options.workspace, options.outputDir).catch((error) => ({ error: error.message }));
    await audit.finish({ status, usage, stats: engine.stats, error: errorText });
    await fs.writeFile(path.join(options.outputDir, 'result.json'), `${JSON.stringify({ convergentVersion: packageJson.version, status, flow: flow.mode, promptFile: options.promptFile ?? null, auditDir, usage, stats: engine.stats, workspace, plan: result?.plan ?? null, error: errorText }, null, 2)}\n`, 'utf8');
    await engine.stop().catch(() => {});
    if (ownsClient) await client.stop().catch(() => {});
  }
}

module.exports = { VALID_FLOWS, extractBenchmarkPrompt, parseArgs, readPrompt, createHeadlessPermissionHandler, createScriptedUserInputHandler, answersFromEnvironment, gitSnapshot, runHeadless };
