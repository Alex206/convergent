'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validationIdentity,
  successfulValidationEvidence,
  reconcileSupersededValidationBlocker,
} = require('../src/orchestrator/report-blocker');
const { ConvergentEngine, reconcileDeterministicIntegrity } = require('../src/orchestrator/engine');

const successfulEvidence = [{
  agent: 'Worker A',
  check: 'TASKFLOW_RELEASE_TOKEN=<operator-provided> PYTHONDONTWRITEBYTECODE=1 python tools/validate_release_signature.py: passed',
}];

function blockedValidatorReport() {
  return {
    verdict: 'blocked',
    summary: 'Implementation is correct, but the unchanged external validator is blocked because TASKFLOW_RELEASE_TOKEN is absent in this agent environment.',
    findings: [],
    checks: [
      'PYTHONDONTWRITEBYTECODE=1 python -m unittest tests.test_release: passed',
      'PYTHONDONTWRITEBYTECODE=1 python tools/validate_release_signature.py: blocked; TASKFLOW_RELEASE_TOKEN is not configured',
    ],
  };
}

test('validator identity and successful-evidence helpers remain diagnostic', () => {
  assert.equal(validationIdentity(successfulEvidence[0].check), 'tools/validate_release_signature.py');
  assert.equal(validationIdentity(blockedValidatorReport().checks[1]), 'tools/validate_release_signature.py');
  assert.equal(successfulValidationEvidence(successfulEvidence[0].check)?.identity, 'tools/validate_release_signature.py');
});

test('same-revision successful validator prose does not rewrite a later structured BLOCKED verdict', () => {
  const result = reconcileSupersededValidationBlocker(blockedValidatorReport(), successfulEvidence, {
    changed: false,
    role: 'Worker B',
  });
  assert.equal(result.report.verdict, 'blocked');
  assert.equal(result.correction, null);
});

test('different validator evidence likewise leaves structured BLOCKED unchanged', () => {
  const result = reconcileSupersededValidationBlocker(blockedValidatorReport(), [{
    agent: 'Worker A',
    check: 'python tools/validate_other_release.py: passed',
  }], { changed: false, role: 'Worker B' });
  assert.equal(result.report.verdict, 'blocked');
});

test('deterministic integrity does not reinterpret validation prose in either direction', () => {
  const result = reconcileDeterministicIntegrity({
    verdict: 'clean',
    summary: blockedValidatorReport().summary,
    findings: [],
    checks: blockedValidatorReport().checks,
  }, {
    changed: false,
    role: 'Worker B',
    validationEvidence: successfulEvidence,
  });
  assert.equal(result.report.verdict, 'clean');
  assert.equal(result.correction, null);
});

test('worker runtime keeps the submitted structured verdict when peer validation prose disagrees', async () => {
  const sink = { value: null };
  const worker = {
    name: 'B',
    sink,
    session: {
      async sendAndWait() {
        sink.value = {
          verdict: 'clean',
          summary: blockedValidatorReport().summary,
          findings: [],
          checks: blockedValidatorReport().checks,
        };
      },
    },
  };
  const engine = new ConvergentEngine({
    client: {}, sdk: {}, workspace: '/repo', models: {}, ui: new Proxy({}, { get: () => () => {} }),
    revisionProvider: async () => 'R1',
  });
  const peerPass = {
    worker: 'A',
    revision: 'R1',
    changed: false,
    report: { verdict: 'clean', summary: 'validated', findings: [], checks: successfulEvidence.map((item) => item.check) },
  };
  const task = {
    id: 'validation-carry',
    title: 'Carry validation evidence',
    description: 'Keep exact-revision required validation evidence.',
    acceptanceCriteria: ['Required validator remains satisfied.'],
  };

  const result = await engine.runWorkerPass(worker, task, 'REVIEW_AND_FIX', null, peerPass);
  assert.equal(result.report.verdict, 'clean');
  assert.equal(result.verdictCorrection, null);
});
