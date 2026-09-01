'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ReviewArchitectureEngine, isReviewerWorkspaceMutationError } = require('../src/orchestrator/review-architecture-engine');
const { normalizeReviewArchitecture, reviewerSpecs } = require('../src/orchestrator/review-architecture');
const { createCompositeReviewer } = require('../src/copilot/review-architecture-session-factory');
const {
  MAX_REVIEW_PROMPT_CYCLES,
  appendReviewDossier,
  formatReviewDossier,
} = require('../src/orchestrator/review-dossier');

function fakeUi() {
  return {
    log() {},
    audit() {},
    auditEvent() {},
    phase() {},
    agentTools() {},
  };
}

function engineWithRevision(getRevision) {
  return new ReviewArchitectureEngine({
    client: {},
    sdk: {},
    workspace: '/repo',
    workspaceFolders: [{ name: 'repo', path: '/repo' }],
    models: {},
    ui: fakeUi(),
    revisionProvider: async () => getRevision(),
    changeStateProvider: async () => null,
  });
}

test('R2/R3 panel stops immediately when one reviewer mutates the workspace', async () => {
  let revision = 'R1';
  const engine = engineWithRevision(() => revision);
  const architecture = normalizeReviewArchitecture('luna-specialized');
  const calls = [0, 0, 0];
  const members = reviewerSpecs(architecture.id).map((spec, index) => {
    const sink = { value: null };
    return {
      label: spec.label,
      reviewSpec: spec,
      usageName: `1-T1:reviewer-${spec.id}`,
      sink,
      session: {
        sessionId: `member-${index}`,
        async sendAndWait() {
          calls[index] += 1;
          sink.value = { verdict: 'clean', findings: [], checks: [], summary: `member ${index} clean` };
          if (index === 0) revision = 'R2';
        },
        async abort() {},
        async disconnect() {},
      },
    };
  });
  const panel = createCompositeReviewer({
    runId: 'test-run',
    usage: engine.usage,
    ui: fakeUi(),
  }, '1-T1', architecture, members, { value: null });

  const restore = await engine.installReviewerMutationGuards(panel, { id: 'T1' }, 1, 'R1', null);
  try {
    await assert.rejects(
      () => panel.session.sendAndWait({ prompt: 'review' }, 1000),
      (error) => {
        assert.equal(isReviewerWorkspaceMutationError(error), true);
        assert.equal(error.incident.reviewerLabel, members[0].label);
        assert.equal(error.incident.beforeRevision, 'R1');
        assert.equal(error.incident.afterRevision, 'R2');
        assert.equal(error.reviewerReport.verdict, 'clean');
        return true;
      },
    );
  } finally {
    restore();
  }

  assert.deepEqual(calls, [1, 0, 0], 'later panel members must never review the contaminated revision');
  assert.equal(panel.sink.value, null, 'the invalid partial reviewer verdict must not become an aggregate acceptance');
});

test('panel guard fails closed if workspace changes between independent reviewers', async () => {
  let revision = 'R1';
  const engine = engineWithRevision(() => revision);
  const architecture = normalizeReviewArchitecture('luna-broad');
  const specs = reviewerSpecs(architecture.id);
  const calls = [0, 0, 0];
  const members = specs.map((spec, index) => {
    const sink = { value: null };
    return {
      label: spec.label,
      reviewSpec: spec,
      usageName: `1-T1:reviewer-${spec.id}`,
      sink,
      session: {
        sessionId: `member-${index}`,
        async sendAndWait() {
          calls[index] += 1;
          sink.value = { verdict: 'clean', findings: [], checks: [], summary: 'clean' };
          if (index === 0) queueMicrotask(() => { revision = 'external-change'; });
        },
        async abort() {},
        async disconnect() {},
      },
    };
  });
  const panel = createCompositeReviewer({ runId: 'run', usage: engine.usage, ui: fakeUi() }, '1-T1', architecture, members, { value: null });
  const restore = await engine.installReviewerMutationGuards(panel, { id: 'T1' }, 1, 'R1', null);
  try {
    await assert.rejects(() => panel.session.sendAndWait({ prompt: 'review' }, 1000), isReviewerWorkspaceMutationError);
  } finally {
    restore();
  }
  assert.equal(calls[0], 1);
  assert.equal(calls[1], 0);
  assert.equal(calls[2], 0);
});

test('review dossier merges retries of the same cycle without preserving hidden conversation', () => {
  let dossier = appendReviewDossier(null, {
    cycle: 1,
    revision: 'R1',
    report: { verdict: 'findings', summary: 'first', findings: [{ severity: 'medium', title: 'A', description: 'a' }], checks: ['test A'] },
    tools: [{ toolName: 'run_command', detail: 'npm test', success: true }],
    usage: { inputTokens: 100, outputTokens: 10 },
  });
  dossier = appendReviewDossier(dossier, {
    cycle: 1,
    revision: 'R1',
    report: { verdict: 'blocked', summary: 'retry', findings: [], checks: ['test A', 'test B'] },
    tools: [{ toolName: 'batch_view', detail: 'src/a.js', success: true }],
    usage: { inputTokens: 50, outputTokens: 5 },
  });
  assert.equal(dossier.cycles.length, 1);
  assert.deepEqual(dossier.cycles[0].checks, ['test A', 'test B']);
  assert.equal(dossier.cycles[0].usage.inputTokens, 150);
  assert.match(formatReviewDossier(dossier), /structured review history, not hidden reasoning/i);
});

test('model-facing review dossier is bounded to recent convergence context while full history remains durable', () => {
  let dossier = null;
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    dossier = appendReviewDossier(dossier, {
      cycle,
      revision: `R${cycle}`,
      report: {
        verdict: 'findings',
        summary: `summary-${cycle}`,
        findings: [{ severity: 'medium', title: `finding-${cycle}`, description: `description-${cycle}` }],
        checks: [`check-${cycle}`],
      },
      tools: [{ toolName: 'batch_view', detail: `tool-detail-${cycle}`, success: true }],
      usage: { inputTokens: cycle * 100000, outputTokens: 1000 },
    });
  }

  assert.equal(dossier.cycles.length, 5, 'checkpoint keeps the complete bounded durable history');
  assert.equal(MAX_REVIEW_PROMPT_CYCLES, 2);
  const prompt = formatReviewDossier(dossier);
  assert.doesNotMatch(prompt, /summary-1|summary-2|summary-3/);
  assert.match(prompt, /summary-4/);
  assert.match(prompt, /summary-5/);
  assert.match(prompt, /3 older review cycle\(s\) are intentionally omitted/i);
  assert.match(prompt, /historical context, not automatically active defects/i);
  assert.doesNotMatch(prompt, /tool-detail|100000 input|AI credits/i, 'tool traces and historical usage stay in the durable dossier, not every model prompt');
});
