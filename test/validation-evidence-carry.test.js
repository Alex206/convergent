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

test('identifies the same validator independent of credential assignment prefix', () => {
  assert.equal(
    validationIdentity(successfulEvidence[0].check),
    'tools/validate_release_signature.py',
  );
  assert.equal(
    validationIdentity(blockedValidatorReport().checks[1]),
    'tools/validate_release_signature.py',
  );
  assert.equal(successfulValidationEvidence(successfulEvidence[0].check)?.identity, 'tools/validate_release_signature.py');
});

test('same-revision successful validator evidence supersedes a later credential-less rerun blocker', () => {
  const result = reconcileSupersededValidationBlocker(blockedValidatorReport(), successfulEvidence, {
    changed: false,
    role: 'Worker B',
  });
  assert.equal(result.report.verdict, 'clean');
  assert.match(result.correction, /exact workspace revision/i);
  assert.match(result.report.checks.join('\n'), /already succeeded/i);
});

test('different validator evidence cannot supersede the blocker', () => {
  const result = reconcileSupersededValidationBlocker(blockedValidatorReport(), [{
    agent: 'Worker A',
    check: 'python tools/validate_other_release.py: passed',
  }], { changed: false, role: 'Worker B' });
  assert.equal(result.report.verdict, 'blocked');
});

test('credential-integrity denial cannot be superseded by prior validator success', () => {
  const report = blockedValidatorReport();
  report.checks.push('Convergent denied synthetic assignment to operator-controlled credential variable(s): TASKFLOW_RELEASE_TOKEN.');
  const result = reconcileSupersededValidationBlocker(report, successfulEvidence, {
    changed: false,
    role: 'Worker B',
  });
  assert.equal(result.report.verdict, 'blocked');
});

test('deterministic pipeline carries matching validation evidence after required-blocker reconciliation', () => {
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
  assert.match(result.correction, /CLEAN -> BLOCKED/);
  assert.match(result.correction, /BLOCKED -> CLEAN/);
});

test('worker runtime accepts same-revision peer validator evidence after an unnecessary missing-credential rerun', async () => {
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
  assert.match(result.verdictCorrection, /BLOCKED -> CLEAN/);
});
