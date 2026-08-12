'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  summarizeArm,
  toCsv,
} = require('../src/headless/architecture-summary');
const {
  architectureRelevantModelIssues,
  sessionModelRecord,
} = require('../src/headless/architecture-runner');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

test('architecture model preflight ignores unused roles but keeps active-role failures', () => {
  const issues = [
    { role: 'coordinator', selector: 'strong' },
    { role: 'workerA', selector: 'strong' },
    { role: 'workerB', selector: 'adaptive' },
    { role: 'reviewer', selector: 'strong' },
  ];
  assert.deepEqual(
    architectureRelevantModelIssues('single-agent', issues).map((item) => item.role),
    ['workerA'],
  );
  assert.deepEqual(
    architectureRelevantModelIssues('implementer-reviewer', issues).map((item) => item.role),
    ['workerA', 'reviewer'],
  );
  assert.deepEqual(
    architectureRelevantModelIssues('convergent-v02', issues).map((item) => item.role),
    ['coordinator', 'workerA', 'workerB', 'reviewer'],
  );
});

test('session model record captures actual role/model provenance from production session events', () => {
  assert.equal(sessionModelRecord({ type: 'worker_pass_result' }), null);
  assert.deepEqual(sessionModelRecord({
    type: 'session_create',
    agent: 'Worker A',
    role: 'workerA',
    taskId: 'task',
    model: 'gpt-5.6-terra',
    modelName: 'GPT-5.6 Terra',
    reasoningEffort: 'low',
    sessionId: 's1',
  }), {
    agent: 'Worker A',
    role: 'workerA',
    taskId: 'task',
    modelId: 'gpt-5.6-terra',
    modelName: 'GPT-5.6 Terra',
    reasoningEffort: 'low',
    sessionId: 's1',
  });
});

test('normalized summary combines result, oracle, efficiency and audit events', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convergent-architecture-summary-'));
  writeJson(path.join(root, 'result.json'), {
    status: 'complete',
    architecture: { id: 'implementer-reviewer', topology: 'implementer -> reviewer', selectors: { implementer: 'strong', reviewer: 'strong' } },
    actualRoleModels: [{ agent: 'Worker A', role: 'workerA', modelId: 'terra', modelName: 'Terra', reasoningEffort: 'low' }],
    usage: { calls: 9, turns: 2, elapsedMs: 42000, aiCredits: 14.8, inputTokens: 100, outputTokens: 20, reasoningTokens: 3, cacheReadTokens: 50, cacheWriteTokens: 10, maxContextTokens: 19000 },
    budget: { chatRequestsUsed: 3 },
  });
  writeJson(path.join(root, 'scenario03-acceptance.json'), {
    ok: true,
    checks: [{ name: 'a', ok: true }, { name: 'b', ok: true }],
  });
  writeJson(path.join(root, 'efficiency-summary.json'), { promptSends: 2, modelCalls: 9, toolCalls: 8 });
  const audit = path.join(root, 'audit', 'run');
  fs.mkdirSync(audit, { recursive: true });
  fs.writeFileSync(path.join(audit, 'events.jsonl'), [
    JSON.stringify({ type: 'worker_pass_result', changed: true }),
    JSON.stringify({ type: 'strong_review_result', review: { findings: [] } }),
  ].join('\n') + '\n');

  const row = summarizeArm(root);
  assert.equal(row.architecture, 'implementer-reviewer');
  assert.equal(row.oraclePass, true);
  assert.equal(row.modelCalls, 9);
  assert.equal(row.aiCredits, 14.8);
  assert.equal(row.chatRequestDelta, 3);
  assert.equal(row.reviewerCycles, 1);
  assert.equal(row.workerPasses, 1);
  assert.equal(row.actualRoleModels[0].modelId, 'terra');

  const csv = toCsv([row]);
  assert.match(csv, /^architecture,oraclePass,/);
  assert.match(csv, /implementer-reviewer,true,2,2,9/);
});
