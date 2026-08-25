'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  inspectAudit,
  buildValidityReport,
} = require('../src/headless/perspective-review-validity');

function writeAudit(root, name, events) {
  const dir = path.join(root, name, 'audit', 'run-1');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  return file;
}

test('validity rejects the historical Terra batch_view planning confound', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convergent-review-validity-'));
  const file = writeAudit(root, 'perspective', [
    {
      type: 'agent_tools',
      topology: 'perspective-luna-terra',
      agent: 'Terra review controller',
      tools: ['custom:batch_view', 'custom:report_review_plan', 'custom:report_review'],
    },
    {
      type: 'tool_start',
      topology: 'perspective-luna-terra',
      agent: 'Terra review controller',
      tool: 'batch_view',
    },
    {
      type: 'tool_start',
      topology: 'perspective-luna-terra',
      agent: 'Terra review controller',
      tool: 'report_review_plan',
    },
  ]);

  const run = inspectAudit(file);
  assert.equal(run.ok, false);
  assert.deepEqual(run.unexpectedDeclared, ['custom:batch_view']);
  assert.deepEqual(run.unexpectedUsed, ['custom:batch_view']);
});

test('validity accepts report-only generic adjudication and plan/report-only perspective control', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convergent-review-validity-'));
  writeAudit(root, 'generic', [
    {
      type: 'agent_tools',
      topology: 'generic-luna-panel-terra',
      agent: 'Terra review controller',
      tools: ['custom:report_review'],
    },
    {
      type: 'tool_start',
      topology: 'generic-luna-panel-terra',
      agent: 'Terra review controller',
      tool: 'report_review',
    },
  ]);
  writeAudit(root, 'perspective', [
    {
      type: 'agent_tools',
      topology: 'perspective-luna-terra',
      agent: 'Terra review controller',
      tools: ['custom:report_review_plan', 'custom:report_review'],
    },
    {
      type: 'tool_start',
      topology: 'perspective-luna-terra',
      agent: 'Terra review controller',
      tool: 'report_review_plan',
    },
    {
      type: 'tool_start',
      topology: 'perspective-luna-terra',
      agent: 'Terra review controller',
      tool: 'report_review',
    },
  ]);

  const report = buildValidityReport(root);
  assert.equal(report.panelRuns, 2);
  assert.equal(report.invalidRuns, 0);
  assert.equal(report.ok, true);
});