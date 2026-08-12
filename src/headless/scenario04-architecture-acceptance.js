#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  parseEvents,
  runScenario04Acceptance,
} = require('./scenario04-acceptance');

function findAfter(events, startIndex, predicate) {
  for (let index = Math.max(0, startIndex + 1); index < events.length; index += 1) {
    if (predicate(events[index], index)) return index;
  }
  return -1;
}

function evaluateArchitectureScenario04Recovery(events = []) {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({
    name,
    ok: Boolean(ok),
    ...(ok || !detail ? {} : { error: detail }),
  });

  const blockedIndex = events.findIndex(
    (event) => event.type === 'worker_pass_result' && event.report?.verdict === 'blocked',
  );
  const recoveryIndex = findAfter(
    events,
    blockedIndex,
    (event) => event.type === 'recovery_decision',
  );
  const recovery = recoveryIndex >= 0 ? events[recoveryIndex] : null;
  const recoveredPassIndex = findAfter(
    events,
    recoveryIndex,
    (event) => event.type === 'worker_pass_result' && ['clean', 'changed'].includes(event.report?.verdict),
  );
  const convergenceIndex = findAfter(events, recoveredPassIndex, (event) => event.type === 'workers_converged');
  const reviewBoundary = convergenceIndex >= 0 ? convergenceIndex : recoveredPassIndex;
  const reviewIndex = findAfter(
    events,
    reviewBoundary,
    (event) => event.type === 'strong_review_result' && event.review?.verdict === 'clean',
  );
  const completeIndex = findAfter(events, reviewIndex, (event) => event.type === 'task_complete');

  check(
    'worker reports BLOCKED for unavailable external validation',
    blockedIndex >= 0,
    'no blocked worker pass was recorded',
  );
  check(
    'strong recovery coordinator records a decision after BLOCKED',
    recoveryIndex > blockedIndex && blockedIndex >= 0,
    'recovery decision missing or occurred before the blocker',
  );
  check(
    'operator guidance is captured by recovery',
    Boolean(String(recovery?.operatorAnswer ?? '').trim()),
    'recovery did not capture scripted operator guidance',
  );
  check(
    'recovery chooses an implementation continuation rather than treating BLOCKED as approval',
    ['retry', 'peer'].includes(recovery?.report?.action) && recoveredPassIndex > recoveryIndex,
    `recovery action=${recovery?.report?.action ?? '<missing>'}; recoveredPassIndex=${recoveredPassIndex}`,
  );
  if (convergenceIndex >= 0) {
    check(
      'peer topology converges only after recovered worker continuation',
      convergenceIndex > recoveredPassIndex,
      `convergenceIndex=${convergenceIndex}; recoveredPassIndex=${recoveredPassIndex}`,
    );
  }
  check(
    'strong reviewer completes clean after recovered implementation boundary',
    reviewIndex > reviewBoundary && reviewBoundary >= 0,
    `reviewIndex=${reviewIndex}; reviewBoundary=${reviewBoundary}`,
  );
  check(
    'task completes only after recovery and clean strong review',
    completeIndex > reviewIndex && reviewIndex >= 0,
    `completeIndex=${completeIndex}; reviewIndex=${reviewIndex}`,
  );

  return {
    ok: checks.every((item) => item.ok),
    checks,
    indices: {
      blockedIndex,
      recoveryIndex,
      recoveredPassIndex,
      convergenceIndex,
      reviewIndex,
      completeIndex,
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const [workspace, eventsFile, output] = argv;
  if (!workspace || !eventsFile) {
    console.error('Usage: node src/headless/scenario04-architecture-acceptance.js <workspace> <events.jsonl> [output.json]');
    return 2;
  }
  const workspaceReport = runScenario04Acceptance(path.resolve(workspace));
  const recoveryReport = evaluateArchitectureScenario04Recovery(parseEvents(path.resolve(eventsFile)));
  const report = {
    ok: workspaceReport.ok && recoveryReport.ok,
    workspace: workspaceReport,
    recovery: recoveryReport,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(path.resolve(output), json, 'utf8');
  }
  process.stdout.write(json);
  return report.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  findAfter,
  evaluateArchitectureScenario04Recovery,
  main,
};
