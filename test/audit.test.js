'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TrajectoryAudit, compactValue } = require('../src/orchestrator/audit');

test('metadata audit hashes source-bearing text while keeping event labels readable', () => {
  const value = compactValue({ type: 'prompt_send', agent: 'Worker A', prompt: 'secret source text', count: 2 }, 'metadata', 1024);
  assert.equal(value.type, 'prompt_send');
  assert.equal(value.agent, 'Worker A');
  assert.equal(value.count, 2);
  assert.equal(value.prompt.kind, 'text');
  assert.equal(value.prompt.chars, 18);
  assert.match(value.prompt.sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(value).includes('secret source text'), false);
});

test('full audit retains bounded text payloads', () => {
  const value = compactValue({ content: 'model message' }, 'full', 1024);
  assert.equal(value.content, 'model message');
});

test('trajectory audit writes manifest events and optimization summary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-audit-'));
  try {
    const audit = new TrajectoryAudit({ rootDir: root, level: 'full', maxRuns: 2, maxSizeMB: 10, maxAgeDays: 7 });
    const directory = await audit.start({ runId: 'run-one', workspace: '/repo', flowMode: 'fast', request: 'do secret work' });
    await audit.record({ type: 'session_create', agent: 'Worker A', modelName: 'Model X', reasoningEffort: 'medium', systemPrompt: 'role prompt' });
    await audit.record({ type: 'prompt_send', agent: 'Worker A', prompt: 'task prompt' });
    await audit.record({ type: 'assistant_usage', agent: 'Worker A', data: { inputTokens: 100, outputTokens: 5, reasoningTokens: 7, cacheReadTokens: 80, cacheWriteTokens: 3 } });
    await audit.record({ type: 'context_usage', agent: 'Worker A', data: { currentTokens: 1234, messagesLength: 19 } });
    const tool = { type: 'tool_start', agent: 'Worker A', tool: 'view', data: { arguments: { path: 'src/example.js' } } };
    await audit.record(tool);
    await audit.record(tool);
    await audit.record({ type: 'assistant_message', agent: 'Worker A', content: 'hello' });
    await audit.finish({ status: 'complete', usage: { inputTokens: 10 } });

    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const events = await fs.readFile(path.join(directory, 'events.jsonl'), 'utf8');
    const summary = JSON.parse(await fs.readFile(path.join(directory, 'summary.json'), 'utf8'));
    assert.equal(manifest.flowMode, 'fast');
    assert.equal(manifest.request, 'do secret work');
    assert.match(events, /assistant_message/);
    assert.equal(summary.status, 'complete');
    assert.equal(summary.eventCounts.assistant_message, 1);
    assert.equal(summary.trajectory.agents['Worker A'].llmCalls, 1);
    assert.equal(summary.trajectory.agents['Worker A'].inputTokens, 100);
    assert.equal(summary.trajectory.agents['Worker A'].cacheReadTokens, 80);
    assert.equal(summary.trajectory.agents['Worker A'].peakContextTokens, 1234);
    assert.equal(summary.trajectory.agents['Worker A'].promptSends, 1);
    assert.equal(summary.trajectory.repeatedToolCalls[0].tool, 'view');
    assert.equal(summary.trajectory.repeatedToolCalls[0].count, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('metadata manifest hashes original request instead of retaining it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-audit-'));
  try {
    const audit = new TrajectoryAudit({ rootDir: root, level: 'metadata' });
    const directory = await audit.start({ runId: 'metadata', flowMode: 'auto', request: 'private repository request' });
    await audit.finish({ status: 'complete' });
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.flowMode, 'auto');
    assert.equal(manifest.request.kind, 'text');
    assert.equal(JSON.stringify(manifest).includes('private repository request'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('audit rotates oldest runs by count', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-audit-'));
  try {
    for (const name of ['r1', 'r2', 'r3']) {
      const audit = new TrajectoryAudit({ rootDir: root, maxRuns: 2, maxSizeMB: 10, maxAgeDays: 7 });
      await audit.start({ runId: name });
      await audit.finish({ status: 'complete' });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const entries = (await fs.readdir(root)).sort();
    assert.equal(entries.length, 2);
    assert.equal(entries.includes('r1'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
