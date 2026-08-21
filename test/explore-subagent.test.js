'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  EXPLORE_AGENT_NAME,
  EXPLORE_TOOLS,
  EXPLORE_PROMPT,
  EXPLORE_DELEGATION_PROMPT,
  createExploreAgent,
  isSubagentEvent,
} = require('../src/copilot/explore-agent');

const available = [
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', supportedReasoningEfforts: ['low', 'medium'] },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', supportedReasoningEfforts: ['medium', 'high'] },
];

test('Explore is a Luna-first isolated read-only custom agent', () => {
  const agent = createExploreAgent({ available }, 'adaptive');
  assert.equal(agent.name, EXPLORE_AGENT_NAME);
  assert.equal(agent.displayName, 'Explore');
  assert.equal(agent.model, 'gpt-5.6-luna');
  assert.equal(agent.reasoningEffort, 'low');
  assert.equal(agent.infer, true);
  assert.deepEqual(agent.tools, ['grep', 'glob', 'view']);
  assert.deepEqual(EXPLORE_TOOLS, ['grep', 'glob', 'view']);
  assert.doesNotMatch(agent.tools.join(' '), /edit|create|shell|bash|powershell|run_command/i);
  assert.match(EXPLORE_PROMPT, /read-only Explore subagent/i);
  assert.match(EXPLORE_PROMPT, /compact evidence handoff/i);
});

test('parent delegation contract skips Explore when deterministic evidence already locates the task', () => {
  assert.match(EXPLORE_DELEGATION_PROMPT, /genuinely unknown/i);
  assert.match(EXPLORE_DELEGATION_PROMPT, /Do NOT delegate when task inspection hints/i);
  assert.match(EXPLORE_DELEGATION_PROMPT, /do not repeat its search/i);
});

test('subagent events are distinguishable from parent events', () => {
  assert.equal(isSubagentEvent({ agentId: 'subagent-1' }), true);
  assert.equal(isSubagentEvent({}), false);
});

test('task roles attach the Explore custom agent while recovery stays bounded without it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'copilot', 'session-factory.js'), 'utf8');
  assert.match(source, /createCoordinator[\s\S]*?customAgents: \[this\.exploreAgent\(\)\]/);
  assert.match(source, /createWorker[\s\S]*?customAgents: \[this\.exploreAgent\(\)\]/);
  assert.match(source, /createReviewer[\s\S]*?customAgents: \[this\.exploreAgent\(\)\]/);
  const recovery = source.match(/async createRecoveryCoordinator[\s\S]*?async createWorker/)?.[0] ?? '';
  assert.doesNotMatch(recovery, /customAgents/);
});
