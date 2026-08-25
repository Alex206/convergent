'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  panelSignal,
  buildPerspectiveReviewReport,
  markdownReport,
} = require('../src/headless/perspective-review-report');

function writeRun(root, name, topology, events) {
  const run = path.join(root, name);
  const audit = path.join(run, 'audit', 'run-1');
  fs.mkdirSync(audit, { recursive: true });
  fs.writeFileSync(path.join(run, 'benchmark-meta.json'), JSON.stringify({
    topology,
    scenario: `benchmarks/${name}.md`,
    repeat: 1,
  }));
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({
    status: 'complete',
    topology,
  }));
  fs.writeFileSync(path.join(audit, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
}

test('panel signal isolates initial Luna discovery from later remediation review cycles', () => {
  const signal = panelSignal([
    { type: 'benchmark_panel_review_result', reviewMode: 'generic', reviewerId: 'g1', label: 'Generic 1', cycle: 1, findings: [] },
    { type: 'benchmark_panel_review_result', reviewMode: 'generic', reviewerId: 'g2', label: 'Generic 2', cycle: 1, findings: [{ severity: 'medium' }] },
    { type: 'benchmark_panel_review_result', reviewMode: 'generic', reviewerId: 'g3', label: 'Generic 3', cycle: 1, findings: [] },
    { type: 'benchmark_panel_adjudication', reviewMode: 'generic', cycle: 1, findings: [{ severity: 'medium' }] },
    { type: 'benchmark_panel_review_result', reviewMode: 'generic', reviewerId: 'g1', label: 'Generic 1', cycle: 2, findings: [{ severity: 'low' }, { severity: 'low' }] },
    { type: 'benchmark_panel_adjudication', reviewMode: 'generic', cycle: 2, findings: [] },
  ]);

  assert.equal(signal.initialReviewerPasses, 3);
  assert.equal(signal.initialReviewerHits, 1);
  assert.equal(signal.initialPanelDetected, true);
  assert.equal(signal.initialFindings, 1);
  assert.equal(signal.totalReviewerPasses, 4);
  assert.equal(signal.totalFindings, 3);
  assert.equal(signal.adjudicationCycles, 2);
  assert.equal(signal.adjudicatedFindings, 1);
});

test('report compares generic and perspective initial discovery and preserves protocol selection signal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convergent-perspective-report-'));

  writeRun(root, 'generic', 'generic-luna-panel-terra', [
    { type: 'benchmark_panel_review_result', reviewMode: 'generic', reviewerId: 'generic-1', label: 'Generic reviewer 1', cycle: 1, findings: [] },
    { type: 'benchmark_panel_review_result', reviewMode: 'generic', reviewerId: 'generic-2', label: 'Generic reviewer 2', cycle: 1, findings: [] },
    { type: 'benchmark_panel_review_result', reviewMode: 'generic', reviewerId: 'generic-3', label: 'Generic reviewer 3', cycle: 1, findings: [] },
    { type: 'benchmark_panel_adjudication', reviewMode: 'generic', cycle: 1, findings: [{ severity: 'medium' }] },
  ]);

  writeRun(root, 'perspective', 'perspective-luna-terra', [
    { type: 'benchmark_review_protocol_plan', reviewMode: 'perspective', selected: ['contract-requirements', 'state-data-flow', 'integration-compatibility'] },
    { type: 'benchmark_panel_review_result', reviewMode: 'perspective', reviewerId: 'contract-requirements', label: 'Contract / requirements', cycle: 1, findings: [{ severity: 'medium' }] },
    { type: 'benchmark_panel_review_result', reviewMode: 'perspective', reviewerId: 'state-data-flow', label: 'State / data-flow', cycle: 1, findings: [{ severity: 'low' }] },
    { type: 'benchmark_panel_review_result', reviewMode: 'perspective', reviewerId: 'integration-compatibility', label: 'Integration / compatibility', cycle: 1, findings: [] },
    { type: 'benchmark_panel_adjudication', reviewMode: 'perspective', cycle: 1, findings: [{ severity: 'medium' }] },
  ]);

  const report = buildPerspectiveReviewReport(root);
  const generic = report.arms.find((arm) => arm.topology === 'generic-luna-panel-terra');
  const perspective = report.arms.find((arm) => arm.topology === 'perspective-luna-terra');

  assert.equal(generic.detectedRuns, 0);
  assert.equal(generic.initialReviewerHits, 0);
  assert.equal(generic.adjudicatedFindings, 1);
  assert.equal(perspective.detectedRuns, 1);
  assert.equal(perspective.initialReviewerHits, 2);
  assert.equal(perspective.initialFindings, 2);
  assert.deepEqual(
    perspective.protocolSelections.map((item) => item.protocol).sort(),
    ['contract-requirements', 'integration-compatibility', 'state-data-flow'],
  );

  const markdown = markdownReport(report);
  assert.match(markdown, /Initial discovery is measured only from Luna panel cycle 1/);
  assert.match(markdown, /generic-luna-panel-terra/);
  assert.match(markdown, /perspective-luna-terra/);
  assert.match(markdown, /Contract \/ requirements/);
  assert.match(markdown, /Perspective protocol selections/);
});