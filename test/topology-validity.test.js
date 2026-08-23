'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  infrastructureFailure,
  quarantineInfrastructureInvalidRuns,
  markdownInvalidRuns,
} = require('../src/headless/topology-validity');
const { buildTournamentReport } = require('../src/headless/topology-report');

function writeRun(root, name, { topology, error = null, accepted = true }) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'benchmark-meta.json'), JSON.stringify({
    topology,
    scenario: 'benchmarks/01-small-duration-parser.md',
    repeat: 1,
  }));
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    status: error ? 'failed' : 'complete',
    topology,
    error,
    usage: { aiCredits: error ? 0 : 3, inputTokens: error ? 0 : 100, calls: error ? 0 : 2, elapsedMs: 100 },
  }));
  fs.writeFileSync(path.join(dir, 'target-validation.json'), JSON.stringify({ ok: accepted }));
  fs.writeFileSync(path.join(dir, 'scenario-acceptance.json'), JSON.stringify({ ok: accepted }));
  return dir;
}

test('only explicit monthly quota failures are infrastructure-invalid', () => {
  assert.equal(infrastructureFailure({ error: 'ordinary implementation failure' }), null);
  assert.deepEqual(
    infrastructureFailure({ error: 'You have exceeded your monthly quota (Request ID: x)' }),
    { category: 'copilot-monthly-quota', reason: 'You have exceeded your monthly quota (Request ID: x)' },
  );
});

test('quota failures are quarantined outside scored results and surfaced separately', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'convergent-topology-validity-'));
  const root = path.join(temp, 'results');
  const invalidRoot = path.join(temp, 'invalid');
  fs.mkdirSync(root);
  writeRun(root, 'valid', { topology: 'candidate' });
  writeRun(root, 'quota', {
    topology: 'candidate',
    error: 'You have exceeded your monthly quota (Request ID: quota-1)',
    accepted: false,
  });
  writeRun(root, 'real-failure', {
    topology: 'candidate',
    error: 'implementation failed',
    accepted: false,
  });

  const invalid = quarantineInfrastructureInvalidRuns(root, invalidRoot);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].category, 'copilot-monthly-quota');
  assert.equal(fs.existsSync(path.join(root, 'quota')), false);
  assert.equal(fs.existsSync(path.join(invalidRoot, 'quota')), true);
  assert.match(markdownInvalidRuns(invalid), /excluded from acceptance, cost-per-success, and Pareto scoring/i);

  const report = buildTournamentReport(root);
  assert.equal(report.runs.length, 2);
  assert.equal(report.topologies[0].runs, 2);
  assert.equal(report.topologies[0].successes, 1);
  assert.equal(report.topologies[0].failures, 1);
  assert.equal(report.topologies[0].acceptanceRate, 0.5);
});

test('invalid quarantine destination must not be inside scored results', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'convergent-topology-validity-scope-'));
  assert.throws(
    () => quarantineInfrastructureInvalidRuns(temp, path.join(temp, 'invalid')),
    /outside the scored topology-results root/i,
  );
});
