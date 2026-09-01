'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_REVIEW_ARCHITECTURE,
  normalizeReviewArchitecture,
  reviewerSpecs,
  aggregateReviewReports,
} = require('../src/orchestrator/review-architecture');
const {
  resolveLunaReviewerModel,
  createCompositeReviewer,
} = require('../src/copilot/review-architecture-session-factory');

function finding(title, description = title) {
  return { severity: 'medium', title, file: 'src/example.js', description };
}

test('0.5 defaults to R3 specialized Luna panel and accepts benchmark aliases', () => {
  assert.equal(DEFAULT_REVIEW_ARCHITECTURE, 'luna-specialized');
  assert.equal(normalizeReviewArchitecture().benchmarkId, 'R3');
  assert.equal(normalizeReviewArchitecture('R1').id, 'terra-single');
  assert.equal(normalizeReviewArchitecture('R2').id, 'luna-broad');
  assert.equal(normalizeReviewArchitecture('R3').id, 'luna-specialized');
});

test('R1 is one Terra reviewer, R2 is three broad Lunas, and R3 has the fixed complementary priorities', () => {
  const r1 = reviewerSpecs('terra-single');
  assert.equal(r1.length, 1);
  assert.equal(r1[0].modelFamily, 'terra');

  const r2 = reviewerSpecs('luna-broad');
  assert.equal(r2.length, 3);
  assert.ok(r2.every((spec) => spec.modelFamily === 'luna'));
  assert.ok(r2.every((spec) => spec.focus.includes('all')));

  const r3 = reviewerSpecs('luna-specialized');
  assert.equal(r3.length, 3);
  assert.deepEqual(r3.map((spec) => spec.focus), [
    ['contract', 'integration-compatibility'],
    ['adversarial', 'security-trust'],
    ['state-dataflow', 'concurrency-resources'],
  ]);
  assert.ok(r3.every((spec) => /not a scope restriction/i.test(spec.prompt)));
});

test('R2/R3 reviewer model resolution is exact Luna and fails closed when Luna is unavailable', () => {
  const luna = {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    supportedReasoningEfforts: ['low', 'medium'],
  };
  const terra = { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' };
  const selected = resolveLunaReviewerModel([terra, luna]);
  assert.equal(selected.id, luna.id);
  assert.match(selected.reason, /requires GPT-5\.6 Luna/i);
  assert.throws(() => resolveLunaReviewerModel([terra]), /requires GPT-5\.6 Luna/i);
});

test('panel aggregation requires all reviewers to be non-blocked and unions actionable findings', () => {
  const duplicate = finding('Duplicate defect');
  const reports = [
    { label: 'A', report: { verdict: 'findings', findings: [duplicate], checks: [], summary: 'found A' } },
    { label: 'B', report: { verdict: 'findings', findings: [duplicate, finding('Second defect')], checks: [], summary: 'found B' } },
    { label: 'C', report: { verdict: 'clean', findings: [], checks: [], summary: 'clean C' } },
  ];
  const aggregate = aggregateReviewReports(reports, 'luna-broad');
  assert.equal(aggregate.verdict, 'findings');
  assert.equal(aggregate.findings.length, 2);

  const blocked = aggregateReviewReports([
    ...reports.slice(0, 2),
    { label: 'C', report: { verdict: 'blocked', findings: [], checks: [], summary: 'environment unavailable' } },
  ], 'luna-specialized');
  assert.equal(blocked.verdict, 'blocked');
  assert.match(blocked.summary, /fail-closed/i);
});

test('composite reviewer reuses the same three persistent members across panel cycles', async () => {
  const architecture = normalizeReviewArchitecture('luna-specialized');
  const calls = [0, 0, 0];
  const members = reviewerSpecs(architecture.id).map((spec, index) => {
    const sink = { value: null };
    return {
      label: spec.label,
      reviewSpec: spec,
      usageName: `review-${index}`,
      sink,
      session: {
        async sendAndWait() {
          calls[index] += 1;
          sink.value = {
            verdict: index === 0 && calls[index] === 1 ? 'findings' : 'clean',
            findings: index === 0 && calls[index] === 1 ? [finding('First-cycle defect')] : [],
            checks: [],
            summary: `member ${index} cycle ${calls[index]}`,
          };
        },
        async abort() {},
        async disconnect() {},
      },
    };
  });
  const refreshed = [];
  const factory = {
    runId: 'test-run',
    usage: {
      recordTurn() {},
      async refresh(key) { refreshed.push(key); },
    },
    ui: { log() {} },
  };
  const sink = { value: null };
  const panel = createCompositeReviewer(factory, 'task-1', architecture, members, sink);

  await panel.session.sendAndWait({ prompt: 'cycle one' }, 1000);
  assert.equal(panel.sink.value.verdict, 'findings');
  assert.equal(panel.sink.value.findings.length, 1);
  assert.deepEqual(calls, [1, 1, 1]);

  await panel.session.sendAndWait({ prompt: 'cycle two' }, 1000);
  assert.equal(panel.sink.value.verdict, 'clean');
  assert.deepEqual(calls, [2, 2, 2]);
  assert.equal(refreshed.length, 6);
});

test('package exposes the review architecture setting and selector command with R3 default', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.5.4');
  assert.equal(pkg.main, './src/extension-0.5.js');
  const setting = pkg.contributes.configuration.properties['convergent.reviewArchitecture'];
  assert.deepEqual(setting.enum, ['terra-single', 'luna-broad', 'luna-specialized']);
  assert.equal(setting.default, 'luna-specialized');
  assert.ok(pkg.contributes.commands.some((entry) => entry.command === 'convergent.selectReviewArchitecture'));
});
