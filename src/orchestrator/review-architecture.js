'use strict';

const DEFAULT_REVIEW_ARCHITECTURE = 'luna-specialized';

const REVIEW_ARCHITECTURES = Object.freeze({
  'terra-single': Object.freeze({
    id: 'terra-single',
    benchmarkId: 'R1',
    label: 'Single Terra',
    description: 'One persistent broad GPT-5.6 Terra reviewer.',
    reviewerCount: 1,
    modelFamily: 'terra',
    specialized: false,
  }),
  'luna-broad': Object.freeze({
    id: 'luna-broad',
    benchmarkId: 'R2',
    label: 'Broad Luna Panel',
    description: 'Three independent persistent GPT-5.6 Luna reviewers, each covering the complete review contract.',
    reviewerCount: 3,
    modelFamily: 'luna',
    specialized: false,
  }),
  'luna-specialized': Object.freeze({
    id: 'luna-specialized',
    benchmarkId: 'R3',
    label: 'Specialized Luna Panel',
    description: 'Three independent persistent GPT-5.6 Luna reviewers with complementary review priorities.',
    reviewerCount: 3,
    modelFamily: 'luna',
    specialized: true,
  }),
});

const ALIASES = Object.freeze({
  r1: 'terra-single',
  terra: 'terra-single',
  single: 'terra-single',
  'single-terra': 'terra-single',
  'terra-single': 'terra-single',
  r2: 'luna-broad',
  broad: 'luna-broad',
  'broad-luna': 'luna-broad',
  'luna-broad': 'luna-broad',
  r3: 'luna-specialized',
  specialized: 'luna-specialized',
  'specialized-luna': 'luna-specialized',
  'luna-specialized': 'luna-specialized',
});

const SPECIALIZED_PARTITIONS = Object.freeze([
  Object.freeze({
    id: 'contract-integration',
    label: 'Contract & integration reviewer',
    focus: ['contract', 'integration-compatibility'],
    prompt: [
      'REVIEW PRIORITY: contract + integration/compatibility.',
      'Give extra depth to explicit and negative requirements, public/internal contracts, caller/callee assumptions, compatibility with previously valid inputs, data-shape/API changes, and whether tests actually lock the requested behavior.',
      'This is a priority overlay, not a scope restriction. The complete reviewer contract remains authoritative; report any material defect you discover outside this focus as well.',
    ].join('\n'),
  }),
  Object.freeze({
    id: 'adversarial-security',
    label: 'Adversarial & security reviewer',
    focus: ['adversarial', 'security-trust'],
    prompt: [
      'REVIEW PRIORITY: adversarial/error-guessing + security/trust boundaries.',
      'Give extra depth to malformed/boundary inputs, hostile compositions, fail-open behavior, authorization/validation assumptions, provenance/trust transitions, exception/error paths, and cases where a later transformation can hide an earlier invalid state.',
      'This is a priority overlay, not a scope restriction. The complete reviewer contract remains authoritative; report any material defect you discover outside this focus as well.',
    ].join('\n'),
  }),
  Object.freeze({
    id: 'state-resources',
    label: 'State & resources reviewer',
    focus: ['state-dataflow', 'concurrency-resources'],
    prompt: [
      'REVIEW PRIORITY: state/data-flow + concurrency/resources.',
      'Give extra depth to state transitions, aliases/ownership, repeated operations, partial failure, cleanup, retries/idempotence, cancellation, ordering, concurrent access, resource lifetime, and whether intermediate state remains valid across the whole operation.',
      'This is a priority overlay, not a scope restriction. The complete reviewer contract remains authoritative; report any material defect you discover outside this focus as well.',
    ].join('\n'),
  }),
]);

function normalizeReviewArchitecture(value, fallback = DEFAULT_REVIEW_ARCHITECTURE) {
  const normalized = String(value ?? '').trim().toLowerCase();
  const id = ALIASES[normalized] ?? (REVIEW_ARCHITECTURES[normalized] ? normalized : fallback);
  return REVIEW_ARCHITECTURES[id] ?? REVIEW_ARCHITECTURES[DEFAULT_REVIEW_ARCHITECTURE];
}

function reviewerSpecs(value) {
  const architecture = normalizeReviewArchitecture(value);
  if (architecture.id === 'terra-single') {
    return [{
      id: 'terra',
      label: 'Strong reviewer',
      modelFamily: 'terra',
      prompt: '',
      focus: [],
    }];
  }
  if (architecture.id === 'luna-broad') {
    return [1, 2, 3].map((index) => ({
      id: `broad-${index}`,
      label: `Broad Luna reviewer ${index}`,
      modelFamily: 'luna',
      focus: ['all'],
      prompt: [
        `INDEPENDENT BROAD REVIEWER ${index}/3.`,
        'Cover the complete reviewer contract across requirements/contracts, adversarial/error paths, state/data-flow, integration/compatibility, security/trust boundaries, concurrency/resources, and test adequacy as relevant.',
        'Do not assume another panel member will cover a defect class for you. Reach your own complete verdict from the current repository state.',
      ].join('\n'),
    }));
  }
  return SPECIALIZED_PARTITIONS.map((partition) => ({ ...partition, modelFamily: 'luna' }));
}

function findingKey(finding = {}) {
  return [finding.severity, finding.title, finding.file, finding.description]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .join('\0');
}

function aggregateReviewReports(memberReports = [], architectureValue = DEFAULT_REVIEW_ARCHITECTURE) {
  const architecture = normalizeReviewArchitecture(architectureValue);
  const findings = [];
  const seen = new Set();
  const checks = [];
  const blocked = [];

  for (const item of memberReports) {
    const report = item?.report ?? {};
    if (report.verdict === 'blocked') blocked.push(item);
    for (const finding of report.findings ?? []) {
      const key = findingKey(finding);
      if (!seen.has(key)) {
        seen.add(key);
        findings.push(finding);
      }
    }
    for (const check of report.checks ?? []) {
      const text = String(check ?? '').trim();
      if (text) checks.push(`${item.label}: ${text}`);
    }
  }

  let verdict = 'clean';
  if (blocked.length) verdict = 'blocked';
  else if (findings.length) verdict = 'findings';

  const summaries = memberReports
    .map((item) => `${item.label}: ${String(item?.report?.summary ?? '').trim()}`)
    .filter((value) => !value.endsWith(':'));

  return {
    verdict,
    findings,
    checks,
    summary: [
      `${architecture.benchmarkId} ${architecture.label}: ${memberReports.length}/${architecture.reviewerCount} reviewer report(s) collected.`,
      blocked.length ? `${blocked.length} reviewer(s) reported BLOCKED; panel acceptance is fail-closed.` : '',
      ...summaries,
    ].filter(Boolean).join(' '),
  };
}

module.exports = {
  DEFAULT_REVIEW_ARCHITECTURE,
  REVIEW_ARCHITECTURES,
  SPECIALIZED_PARTITIONS,
  normalizeReviewArchitecture,
  reviewerSpecs,
  aggregateReviewReports,
  findingKey,
};
