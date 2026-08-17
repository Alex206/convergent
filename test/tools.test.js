'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPlanTool,
  createPassTool,
  createReviewTool,
  normalizePassReport,
  validatePassReport,
  normalizeReviewReport,
  validateReviewReport,
  recoverPassReportFromText,
  recoverReviewReportFromText,
} = require('../src/copilot/tools');

function captureDefinition(name, definition) {
  return { name, ...definition };
}

test('structured report tools stay eagerly available to agents', () => {
  for (const factory of [createPlanTool, createPassTool, createReviewTool]) {
    const tool = factory(captureDefinition, { value: null });
    assert.equal(tool.defer, 'never');
    assert.equal(tool.skipPermission, true);
  }
});

test('plan schema requires workflow route, risk, and rationale for every task', () => {
  const tool = createPlanTool(captureDefinition, { value: null });
  const taskSchema = tool.parameters.properties.tasks.items;
  assert.deepEqual(taskSchema.properties.route.enum, ['read_only', 'trivial', 'standard', 'high_risk']);
  assert.deepEqual(taskSchema.properties.risk.enum, ['low', 'medium', 'high']);
  assert.ok(taskSchema.required.includes('route'));
  assert.ok(taskSchema.required.includes('risk'));
  assert.ok(taskSchema.required.includes('routingReason'));
});

test('pass reports normalize non-array findings and checks instead of crashing peer exchange', () => {
  const report = normalizePassReport({
    verdict: 'blocked',
    summary: 'cannot resolve issue safely',
    findings: { title: 'Race', description: 'Shutdown can race.' },
    checks: 'tests passed',
  });
  assert.deepEqual(report.findings, ['Race: Shutdown can race.']);
  assert.deepEqual(report.checks, ['tests passed']);
});

test('clean and changed worker reports reject unresolved findings', async () => {
  for (const verdict of ['clean', 'changed']) {
    const sink = { value: null };
    const tool = createPassTool(captureDefinition, sink);
    const result = await tool.handler({
      verdict,
      summary: 'Peer claim was incorrect; current repository is valid.',
      findings: ['Peer was wrong about the file layout.'],
      checks: ['tests passed'],
    });
    assert.equal(result.accepted, false);
    assert.equal(result.retry, true);
    assert.match(result.error, /findings=\[\]/);
    assert.equal(sink.value, null);
  }
});

test('worker disagreements belong in summary and allow a clean report with no findings', async () => {
  const sink = { value: null };
  const tool = createPassTool(captureDefinition, sink);
  const result = await tool.handler({
    verdict: 'clean',
    summary: 'Worker B claimed the files were reversed, but inspection and tests show the current layout is correct.',
    findings: [],
    checks: ['script runs', 'unit test passes'],
  });
  assert.equal(result.accepted, true);
  assert.equal(sink.value.verdict, 'clean');
  assert.deepEqual(sink.value.findings, []);
});

test('pass semantic validator keeps the convergence invariant explicit', () => {
  assert.match(validatePassReport({ verdict: 'clean', findings: ['x'] }), /CLEAN/);
  assert.match(validatePassReport({ verdict: 'changed', findings: ['x'] }), /CHANGED/);
  assert.equal(validatePassReport({ verdict: 'clean', findings: [] }), null);
});

test('serialized report_pass assistant text is recovered and normalized', () => {
  const report = recoverPassReportFromText(`Some completion prose.\n<report_pass>\n<verdict>changed</verdict>\n<summary>Implemented identity split.</summary>\n<findings>[]</findings>\n<checks>\n- 260 tests passed\n- targeted protocol tests passed\n</checks>\n</report_pass>`);
  assert.deepEqual(report, {
    verdict: 'changed',
    summary: 'Implemented identity split.',
    findings: [],
    checks: ['260 tests passed', 'targeted protocol tests passed'],
  });
});

test('serialized report_pass fallback rejects contradictory clean findings', () => {
  const report = recoverPassReportFromText(`<report_pass><verdict>clean</verdict><summary>done</summary><findings>- unresolved race</findings><checks>[]</checks></report_pass>`);
  assert.equal(report, null);
});

test('review reports normalize a single string finding into the strong-review shape', () => {
  const report = normalizeReviewReport({
    verdict: 'findings',
    summary: 'one issue',
    findings: 'Missing negative-path test',
    checks: null,
  });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].severity, 'medium');
  assert.equal(report.findings[0].description, 'Missing negative-path test');
  assert.deepEqual(report.checks, []);
});

test('strong-review semantic validator rejects contradictory verdict/findings combinations', () => {
  assert.match(validateReviewReport({ verdict: 'clean', findings: [{ description: 'x' }] }), /CLEAN/);
  assert.match(validateReviewReport({ verdict: 'findings', findings: [] }), /FINDINGS/);
  assert.equal(validateReviewReport({ verdict: 'clean', findings: [] }), null);
});

test('serialized clean report_review assistant text is recovered', () => {
  const report = recoverReviewReportFromText(`<report_review>\n<verdict>clean</verdict>\n<summary>No actionable findings.</summary>\n<findings>[]</findings>\n<checks>- inspected diff</checks>\n</report_review>`);
  assert.equal(report.verdict, 'clean');
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.checks, ['inspected diff']);
});

test('plan task schema carries an optional coordinator-proven workingRef', async () => {
  const sink = { value: null };
  const tool = createPlanTool(captureDefinition, sink);
  assert.equal(tool.parameters.properties.tasks.items.properties.workingRef.type, 'string');
  const result = await tool.handler({
    summary: 'Use the existing PR head.',
    tasks: [{
      id: 'T1', title: 'Harden backend', description: 'Harden existing code',
      acceptanceCriteria: ['Tests pass'], route: 'standard', risk: 'medium',
      architectureSignificance: 'low', routingReason: 'Local implementation change',
      inspectionHints: [], workingRef: 'origin/agent/target-memory-control',
    }],
  });
  assert.equal(result.accepted, true);
  assert.equal(sink.value.tasks[0].workingRef, 'origin/agent/target-memory-control');
});
