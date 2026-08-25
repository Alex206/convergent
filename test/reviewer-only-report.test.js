'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  matchesExpectedDefect,
  loadRuns,
  summarize,
  markdown,
} = require('../src/headless/reviewer-only-report');

function finding(title, description = '') {
  return { severity: 'high', title, description, file: 'taskflow/example.py' };
}

function writeRun(root, name, { arm, caseId, findings = [], credits = 1, calls = 2, repeat = 1 }) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'benchmark-meta.json'), JSON.stringify({ caseId, repeat }));
  fs.writeFileSync(path.join(dir, 'reviewer-only-result.json'), JSON.stringify({
    status: 'complete',
    arm,
    armLabel: arm,
    reports: [{ reviewerId: 'r1', label: 'Reviewer 1', modelId: 'model', findings, verdict: findings.length ? 'findings' : 'clean' }],
    usage: { aiCredits: credits, calls, inputTokens: 100, elapsedMs: 1000 },
  }));
}

test('expected-defect matchers recognize the intended frozen failure classes', () => {
  assert.equal(matchesExpectedDefect('s08-symlink-reentry', finding('Symlink escape can re-enter root', 'Path resolution only validates the final target after .. traversal.')), true);
  assert.equal(matchesExpectedDefect('s09-mappingproxy', finding('deepcopy rejects MappingProxyType')), true);
  assert.equal(matchesExpectedDefect('s10-baseexception', finding('except Exception skips KeyboardInterrupt cleanup')), true);
  assert.equal(matchesExpectedDefect('s10-baseexception', finding('unrelated style concern')), false);
});

test('report computes defect recall and clean false-positive rate per architecture', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-only-report-'));
  writeRun(root, 'terra-defect', {
    arm: 'terra-broad',
    caseId: 's10-baseexception',
    findings: [finding('except Exception skips BaseException cleanup')],
    credits: 3,
    calls: 4,
  });
  writeRun(root, 'terra-clean', {
    arm: 'terra-broad',
    caseId: 's09-clean',
    findings: [],
    credits: 2,
    calls: 3,
  });
  writeRun(root, 'luna-defect', {
    arm: 'luna-broad-3',
    caseId: 's10-baseexception',
    findings: [],
    credits: 1,
    calls: 6,
  });
  writeRun(root, 'luna-clean', {
    arm: 'luna-broad-3',
    caseId: 's09-clean',
    findings: [finding('Speculative cleanup refactor')],
    credits: 1,
    calls: 6,
  });

  const runs = loadRuns(root);
  const summary = summarize(runs);
  const terra = summary.find((entry) => entry.arm === 'terra-broad');
  const luna = summary.find((entry) => entry.arm === 'luna-broad-3');
  assert.equal(terra.defectRecall, 1);
  assert.equal(terra.cleanFalsePositiveRate, 0);
  assert.equal(luna.defectRecall, 0);
  assert.equal(luna.cleanFalsePositiveRate, 1);
  assert.match(markdown(runs, summary), /Equalized Reviewer-Only Benchmark/);
  assert.match(markdown(runs, summary), /expected-hit/);
});
