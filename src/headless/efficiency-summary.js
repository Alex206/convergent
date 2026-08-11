#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function agentEntry(map, name) {
  const key = String(name ?? 'unknown');
  if (!map.has(key)) {
    map.set(key, {
      promptSends: 0,
      modelCalls: 0,
      toolCalls: 0,
      reportRecoveries: 0,
      sessionModels: new Set(),
      runtimeModels: new Map(),
      turns: [],
      currentTurn: null,
    });
  }
  return map.get(key);
}

function finishTurn(entry) {
  if (!entry.currentTurn) return;
  entry.turns.push(entry.currentTurn);
  entry.currentTurn = null;
}

function analyzeEfficiency(events = []) {
  const agents = new Map();
  let chatStartUsed = null;
  let chatLastUsed = null;
  let taskStarts = 0;
  let taskCompletes = 0;

  for (const event of events) {
    const type = String(event?.type ?? '');
    const entry = event?.agent ? agentEntry(agents, event.agent) : null;

    if (type === 'session_create' && entry) {
      entry.sessionModels.add(String(event.model ?? event.modelName ?? 'unknown'));
    } else if (type === 'prompt_send' && entry) {
      finishTurn(entry);
      entry.promptSends += 1;
      entry.currentTurn = { modelCalls: 0, toolCalls: 0, runtimeModels: {} };
    } else if (type === 'assistant_usage' && entry) {
      entry.modelCalls += 1;
      if (!entry.currentTurn) entry.currentTurn = { modelCalls: 0, toolCalls: 0, runtimeModels: {} };
      entry.currentTurn.modelCalls += 1;
      const runtimeModel = String(event?.data?.model ?? event?.model ?? 'unknown');
      entry.runtimeModels.set(runtimeModel, (entry.runtimeModels.get(runtimeModel) ?? 0) + 1);
      entry.currentTurn.runtimeModels[runtimeModel] = (entry.currentTurn.runtimeModels[runtimeModel] ?? 0) + 1;

      const used = Number(event?.data?.quotaSnapshots?.chat?.usedRequests);
      if (Number.isFinite(used)) {
        if (chatStartUsed === null || used < chatStartUsed) chatStartUsed = used;
        chatLastUsed = used;
      }
    } else if (type === 'tool_start' && entry) {
      entry.toolCalls += 1;
      if (!entry.currentTurn) entry.currentTurn = { modelCalls: 0, toolCalls: 0, runtimeModels: {} };
      entry.currentTurn.toolCalls += 1;
    } else if (type === 'agent_report_recovered' && entry) {
      entry.reportRecoveries += 1;
    } else if (type === 'task_start') {
      taskStarts += 1;
    } else if (type === 'task_complete') {
      taskCompletes += 1;
    }
  }

  let promptSends = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let reportRecoveries = 0;
  const autoSessionAgents = [];
  const agentSummaries = {};

  for (const [name, entry] of agents) {
    finishTurn(entry);
    promptSends += entry.promptSends;
    modelCalls += entry.modelCalls;
    toolCalls += entry.toolCalls;
    reportRecoveries += entry.reportRecoveries;
    if (entry.sessionModels.has('auto')) autoSessionAgents.push(name);
    const maxModelCallsPerPrompt = entry.turns.reduce((max, turn) => Math.max(max, turn.modelCalls), 0);
    const maxToolCallsPerPrompt = entry.turns.reduce((max, turn) => Math.max(max, turn.toolCalls), 0);
    agentSummaries[name] = {
      promptSends: entry.promptSends,
      modelCalls: entry.modelCalls,
      toolCalls: entry.toolCalls,
      modelCallsPerPrompt: entry.promptSends ? entry.modelCalls / entry.promptSends : null,
      maxModelCallsPerPrompt,
      maxToolCallsPerPrompt,
      reportRecoveries: entry.reportRecoveries,
      sessionModels: [...entry.sessionModels],
      runtimeModels: Object.fromEntries(entry.runtimeModels),
      turns: entry.turns,
    };
  }

  const chatRequestDelta = chatStartUsed === null || chatLastUsed === null
    ? null
    : Math.max(0, chatLastUsed - chatStartUsed);
  const amplification = promptSends ? modelCalls / promptSends : null;
  const warnings = [];
  if (autoSessionAgents.length) warnings.push({ kind: 'auto_session_model', agents: autoSessionAgents });
  if (amplification !== null && amplification > 6) warnings.push({ kind: 'model_call_amplification', value: amplification, threshold: 6 });
  for (const [agent, summary] of Object.entries(agentSummaries)) {
    if (summary.maxModelCallsPerPrompt > 10) warnings.push({ kind: 'runaway_agent_turn', agent, value: summary.maxModelCallsPerPrompt, threshold: 10 });
  }
  if (reportRecoveries) warnings.push({ kind: 'serialized_report_recovery', count: reportRecoveries });

  return {
    promptSends,
    modelCalls,
    toolCalls,
    modelCallsPerPrompt: amplification,
    chatQuota: {
      startUsedRequests: chatStartUsed,
      lastUsedRequests: chatLastUsed,
      deltaUsedRequests: chatRequestDelta,
    },
    tasks: { started: taskStarts, completed: taskCompletes },
    reportRecoveries,
    autoSessionAgents,
    agents: agentSummaries,
    warnings,
  };
}

async function readEvents(file) {
  const text = await fs.readFile(file, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function summarizeFile(inputFile, outputFile = null) {
  const summary = analyzeEfficiency(await readEvents(inputFile));
  if (outputFile) {
    const target = path.resolve(outputFile);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }
  return summary;
}

async function main() {
  const inputFile = process.argv[2];
  const outputFile = process.argv[3];
  if (!inputFile) throw new Error('Usage: node src/headless/efficiency-summary.js <events.jsonl> [output.json]');
  const summary = await summarizeFile(inputFile, outputFile);
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}

module.exports = { analyzeEfficiency, readEvents, summarizeFile };
