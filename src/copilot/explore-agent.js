'use strict';

const { resolveModel } = require('../orchestrator/model-resolver');
const { chooseReasoningEffort } = require('../orchestrator/routing');

const EXPLORE_AGENT_NAME = 'convergent-explore';
const EXPLORE_TOOLS = ['grep', 'glob', 'view'];

const EXPLORE_PROMPT = `
You are Convergent's read-only Explore subagent. Your only job is to locate and understand the minimum repository surfaces needed by the parent agent.

Use search and file reads only. Do not edit files, run builds/tests, execute shell commands, make user-facing decisions, or redesign the task.

Return a compact evidence handoff rather than a transcript of your searches. Prefer this structure when applicable:
- Relevant files and why they matter
- Relevant symbols/contracts
- Focused tests/configuration
- Existing pattern or constraint the parent should preserve
- Unresolved repository-location questions

Stop as soon as the parent has enough evidence to continue. Do not reread files merely for reassurance and do not broaden into unrelated repository areas.
`;

const EXPLORE_DELEGATION_PROMPT = `
A read-only Explore subagent is available for isolated repository research. Delegate to Explore only when relevant files/symbols/contracts are genuinely unknown and broad location work would otherwise consume this agent's main context. Do NOT delegate when task inspection hints, the deterministic task-change manifest, prior validation evidence, or your retained context already identify the needed surfaces. Use Explore for repository discovery, not implementation, validation execution, architecture decisions, or routine re-checking. Continue your own task from Explore's compact findings; do not repeat its search merely for reassurance.
`;

function createExploreAgent(models = {}, reasoningMode = 'adaptive', workspacePrompt = '') {
  const model = resolveModel('cheap-a', models.available ?? []);
  const reasoningEffort = chooseReasoningEffort(model, 'low', reasoningMode);
  const prompt = [EXPLORE_PROMPT, String(workspacePrompt ?? '').trim()].filter(Boolean).join('\n\n');
  return {
    name: EXPLORE_AGENT_NAME,
    displayName: 'Explore',
    description: 'Read-only codebase exploration for locating relevant files, symbols, tests, configuration, and existing patterns while keeping discovery out of the parent context.',
    tools: [...EXPLORE_TOOLS],
    prompt,
    infer: true,
    ...(model.id && model.id !== 'auto' ? { model: model.id } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function isSubagentEvent(event) {
  return Boolean(event?.agentId);
}

function describeSubagentEvent(data = {}) {
  return String(
    data.description
      ?? data.task
      ?? data.prompt
      ?? data.agentName
      ?? data.name
      ?? '',
  ).replace(/\s+/g, ' ').trim().slice(0, 180);
}

module.exports = {
  EXPLORE_AGENT_NAME,
  EXPLORE_TOOLS,
  EXPLORE_PROMPT,
  EXPLORE_DELEGATION_PROMPT,
  createExploreAgent,
  isSubagentEvent,
  describeSubagentEvent,
};
