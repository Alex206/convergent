#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runProbe(command, args, workspace) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: workspace },
  });
  if (result.status !== 0) {
    throw new Error(`${command} probe failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim());
}

function runPython(workspace, source) {
  return runProbe('python3', ['-B', '-c', source], workspace);
}

function runNode(workspace, source) {
  return runProbe('node', ['-e', source], workspace);
}

function falseKeys(checks) {
  return Object.entries(checks ?? {}).filter(([, value]) => value === false).map(([key]) => key).sort();
}

function validateDispatch(workspace) {
  return runPython(workspace, String.raw`
import json
from taskflow.dispatch_service import DispatchService

checks = {}

service = DispatchService()
job = service.submit("alpha", "r1", "build")
lease = service.claim("worker-a", now=10, ttl=5)
completed = service.complete(lease, "ok", now=12)
checks["baseline_submit_claim_complete"] = (
    job.tenant == "alpha"
    and completed.status == "completed"
    and completed.result == "ok"
)

service = DispatchService()
alpha = service.submit("alpha", "shared", "alpha-payload")
beta = service.submit("beta", "shared", "beta-payload")
checks["tenant_idempotency_isolation"] = (
    alpha.tenant == "alpha"
    and beta.tenant == "beta"
    and alpha.job_id != beta.job_id
    and beta.payload == "beta-payload"
)

service = DispatchService()
job = service.submit("alpha", "r1", "build")
old = service.claim("worker-a", now=10, ttl=2)
current = service.claim("worker-a", now=12, ttl=5)
stale_rejected = False
try:
    service.complete(old, "stale-result", now=13)
except RuntimeError:
    stale_rejected = True
after = service.get("alpha", job.job_id)
checks["stale_lease_after_reclaim"] = (
    stale_rejected
    and current.generation > old.generation
    and after.status == "leased"
    and after.generation == current.generation
    and after.result is None
)

service = DispatchService()
job = service.submit("alpha", "r1", "build")
service.cancel("alpha", job.job_id)
claim = service.claim("worker-a", now=10, ttl=5)
after = service.get("alpha", job.job_id)
checks["terminal_queue_entry_not_claimable"] = claim is None and after.status == "cancelled"

print(json.dumps({"checks": checks}))
`);
}

function validateHistoricalBudget(workspace) {
  const runner = JSON.stringify(path.join(workspace, 'src', 'headless', 'runner.js'));
  return runNode(workspace, String.raw`
const { createModelCallBudget } = require(${runner});

function usage(agent, sessionId) {
  return { type: 'assistant_usage', agent, sessionId, data: {} };
}
function toolStart(agent, sessionId, toolCallId, tool) {
  return { type: 'tool_start', agent, sessionId, tool, data: { toolCallId } };
}
function toolComplete(agent, sessionId, toolCallId, result) {
  return {
    type: 'tool_complete', agent, sessionId,
    data: { toolCallId, result: { content: JSON.stringify(result) } },
  };
}
function exercise(toolCompletesBeforeFinalUsage) {
  const breaches = [];
  const stops = [];
  const budget = createModelCallBudget({
    maxTotalCalls: 24,
    maxCallsPerTurn: 10,
    onExceeded: (value) => breaches.push(value),
    onTurnLimit: (value) => stops.push(value),
  });
  const agent = 'Worker A';
  const session = 'worker-session';
  budget.handle({ type: 'prompt_send', agent, sessionId: session });
  for (let index = 0; index < 9; index += 1) budget.handle(usage(agent, session));
  budget.handle(toolStart(agent, session, 'report-10', 'report_pass'));
  if (toolCompletesBeforeFinalUsage) {
    budget.handle(toolComplete(agent, session, 'report-10', { accepted: true, verdict: 'changed' }));
    budget.handle(usage(agent, session));
  } else {
    budget.handle(usage(agent, session));
    budget.handle(toolComplete(agent, session, 'report-10', { accepted: true, verdict: 'changed' }));
  }
  budget.handle({ type: 'assistant_turn_end', agent, sessionId: session });
  return { breaches, stops, snapshot: budget.snapshot() };
}

const usageFirst = exercise(false);
const toolFirst = exercise(true);
const graceful = (value) => (
  value.breaches.length === 0
  && value.stops.length === 1
  && Object.keys(value.snapshot.pendingTurnLimits ?? {}).length === 0
);
console.log(JSON.stringify({ checks: {
  baseline_usage_before_tool_completion: graceful(usageFirst),
  accepted_report_order_invariance: graceful(toolFirst),
}}));
`);
}

const CASES = Object.freeze({
  'v5-s19-dispatch-multidefect': {
    validator: validateDispatch,
    expected: ['tenant_idempotency_isolation', 'stale_lease_after_reclaim', 'terminal_queue_entry_not_claimable'],
  },
  'v5-s19-dispatch-clean': { validator: validateDispatch, expected: [] },
  'v5-h22-budget-regression': { validator: validateHistoricalBudget, expected: ['accepted_report_order_invariance'] },
  'v5-h22-budget-fixed': { validator: validateHistoricalBudget, expected: [] },
});

function validateCase(caseId, workspace) {
  const spec = CASES[caseId];
  if (!spec) throw new Error(`Unknown reviewer-v5 case ${JSON.stringify(caseId)}.`);
  const oracle = spec.validator(workspace);
  const failed = falseKeys(oracle.checks);
  const expected = [...spec.expected].sort();
  return {
    valid: JSON.stringify(failed) === JSON.stringify(expected),
    expectedDefects: expected,
    oracle,
  };
}

function main(argv = process.argv.slice(2)) {
  const caseId = String(argv[0] ?? '').trim();
  const workspace = path.resolve(argv[1] ?? '.');
  const output = path.resolve(argv[2] ?? path.join(process.cwd(), 'reviewer-v5-case-validation.json'));
  let result;
  try {
    result = { caseId, ...validateCase(caseId, workspace) };
  } catch (error) {
    result = { caseId, valid: false, error: error?.message ?? String(error) };
  }
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { CASES, falseKeys, validateDispatch, validateHistoricalBudget, validateCase };
