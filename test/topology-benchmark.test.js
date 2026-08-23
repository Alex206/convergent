'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  topologyNames,
  normalizeTopology,
  applyTopologySelectors,
  topologyConfig,
} = require('../src/headless/topology');
const {
  SINGLE_AGENT_TOOLS,
} = require('../src/headless/single-agent-baseline');
const {
  COMPACT_WORKER_A_PROMPT,
  COMPACT_REVIEWER_PROMPT,
  LEAN_WORKER_A_PROMPT,
  LEAN_REVIEWER_PROMPT,
  LEAN_WORKER_TOOLS,
  LEAN_REVIEWER_TOOLS,
  STRUCTURED_READ_TOOLS,
  STRUCTURED_REVIEWER_TOOLS,
  structuredWorkerTools,
} = require('../src/headless/topology-engine');
const {
  loadRun,
  aggregateTopology,
  paretoFrontier,
  buildTournamentReport,
} = require('../src/headless/topology-report');

test('benchmark topology set contains the intended architecture experiment arms', () => {
  assert.deepEqual(topologyNames(), [
    'terra-solo',
    'luna-terra',
    'luna-terra-compact',
    'luna-terra-lean',
    'luna-terra-structured',
    'luna-luna-structured',
    'luna-terra-capable',
    'luna-peer-terra',
    'luna-ab-terra',
    'terra-terra',
  ]);
  assert.equal(topologyConfig('terra-solo').kind, 'single_agent');
  assert.equal(topologyConfig('luna-terra-compact').promptProfile, 'compact-standard');
  assert.equal(topologyConfig('luna-terra-lean').promptProfile, 'lean-standard');
  assert.equal(topologyConfig('luna-terra-lean').toolProfile, 'lean');
  assert.equal(topologyConfig('luna-terra-structured').promptProfile, 'lean-standard');
  assert.equal(topologyConfig('luna-terra-structured').toolProfile, 'structured');
  assert.equal(topologyConfig('luna-luna-structured').promptProfile, 'lean-standard');
  assert.equal(topologyConfig('luna-luna-structured').toolProfile, 'structured');
  assert.equal(topologyConfig('luna-terra-capable').promptProfile, 'lean-standard');
  assert.equal(topologyConfig('luna-terra-capable').toolProfile, 'full');
  assert.equal(topologyConfig('luna-peer-terra').peerMode, 'critic');
  assert.equal(topologyConfig('luna-ab-terra').peerMode, 'converge');
  assert.throws(() => normalizeTopology('mystery'), /Unsupported benchmark topology/);
});

test('topology selectors pin Terra/Luna explicitly instead of silently using strong/auto', () => {
  const solo = applyTopologySelectors({ topology: 'terra-solo' });
  assert.equal(solo.workerA, 'gpt-5.6-terra');
  assert.equal(solo.coordinator, 'gpt-5.6-terra');
  assert.equal(solo.reviewer, 'gpt-5.6-terra');

  const economical = applyTopologySelectors({ topology: 'luna-terra' });
  assert.equal(economical.workerA, 'gpt-5.6-luna');
  assert.equal(economical.reviewer, 'gpt-5.6-terra');

  const lean = applyTopologySelectors({ topology: 'luna-terra-lean' });
  assert.equal(lean.workerA, 'gpt-5.6-luna');
  assert.equal(lean.reviewer, 'gpt-5.6-terra');

  const structured = applyTopologySelectors({ topology: 'luna-terra-structured' });
  assert.equal(structured.workerA, 'gpt-5.6-luna');
  assert.equal(structured.reviewer, 'gpt-5.6-terra');

  const lunaReviewed = applyTopologySelectors({ topology: 'luna-luna-structured' });
  assert.equal(lunaReviewed.coordinator, 'gpt-5.6-terra');
  assert.equal(lunaReviewed.workerA, 'gpt-5.6-luna');
  assert.equal(lunaReviewed.reviewer, 'gpt-5.6-luna');

  const capable = applyTopologySelectors({ topology: 'luna-terra-capable' });
  assert.equal(capable.workerA, 'gpt-5.6-luna');
  assert.equal(capable.reviewer, 'gpt-5.6-terra');

  const peer = applyTopologySelectors({ topology: 'luna-peer-terra' });
  assert.equal(peer.workerA, 'gpt-5.6-luna');
  assert.equal(peer.workerB, 'adaptive-diverse');
});

test('compact standard prompts retain core safety/report semantics without production prompt bulk', () => {
  assert.ok(COMPACT_WORKER_A_PROMPT.length < 2200);
  assert.ok(COMPACT_REVIEWER_PROMPT.length < 2200);
  assert.match(COMPACT_WORKER_A_PROMPT, /pre-existing/);
  assert.match(COMPACT_WORKER_A_PROMPT, /workspace fingerprint is an opaque state hash/);
  assert.match(COMPACT_WORKER_A_PROMPT, /report_pass exactly once/);
  assert.match(COMPACT_REVIEWER_PROMPT, /read-only strong quality gate/);
  assert.match(COMPACT_REVIEWER_PROMPT, /report_review exactly once/);
  assert.match(COMPACT_REVIEWER_PROMPT, /CLEAN requires findings=\[\]/);
});

test('lean standard profile preserves safety while removing unused exploration and redundant tool surface', () => {
  assert.ok(LEAN_WORKER_A_PROMPT.length < 1800);
  assert.ok(LEAN_REVIEWER_PROMPT.length < 1800);
  assert.match(LEAN_WORKER_A_PROMPT, /pre-existing/);
  assert.match(LEAN_WORKER_A_PROMPT, /workspace fingerprint is an opaque state hash/);
  assert.match(LEAN_WORKER_A_PROMPT, /report_pass exactly once/);
  assert.doesNotMatch(LEAN_WORKER_A_PROMPT, /Explore/);
  assert.match(LEAN_REVIEWER_PROMPT, /deterministic task-change manifest and bounded current diff/);
  assert.match(LEAN_REVIEWER_PROMPT, /report_review exactly once/);
  assert.doesNotMatch(LEAN_REVIEWER_PROMPT, /Explore/);
  assert.deepEqual(LEAN_WORKER_TOOLS, [
    'builtin:view',
    'custom:batch_view',
    'custom:run_command',
    'builtin:apply_patch',
    'builtin:edit',
    'builtin:create',
    'custom:report_pass',
  ]);
  assert.deepEqual(LEAN_REVIEWER_TOOLS, [
    'builtin:view',
    'custom:batch_view',
    'custom:run_command',
    'custom:report_review',
  ]);
});

test('structured profile keeps natural inspection and managed command escape hatches without duplicate shell surface', () => {
  assert.deepEqual(STRUCTURED_READ_TOOLS, [
    'builtin:view',
    'builtin:glob',
    'builtin:rg',
  ]);
  assert.deepEqual(STRUCTURED_REVIEWER_TOOLS, [
    'builtin:view',
    'builtin:glob',
    'builtin:rg',
    'custom:batch_view',
    'custom:run_command',
    'custom:report_review',
  ]);
  assert.ok(!STRUCTURED_REVIEWER_TOOLS.some((tool) => /bash|powershell|grep/.test(tool)));

  const singleRootWorker = structuredWorkerTools(false);
  assert.ok(singleRootWorker.includes('builtin:view'));
  assert.ok(singleRootWorker.includes('builtin:glob'));
  assert.ok(singleRootWorker.includes('builtin:rg'));
  assert.ok(singleRootWorker.includes('custom:batch_view'));
  assert.ok(singleRootWorker.includes('custom:run_command'));
  assert.ok(!singleRootWorker.includes('custom:workspace_edit'));
  assert.ok(!singleRootWorker.some((tool) => /bash|powershell|grep/.test(tool)));

  const multiRootWorker = structuredWorkerTools(true);
  assert.ok(multiRootWorker.includes('custom:workspace_edit'));
});

test('single Terra baseline has editing/validation tools but no Convergent report tool', () => {
  assert.ok(SINGLE_AGENT_TOOLS.includes('custom:run_command'));
  assert.ok(SINGLE_AGENT_TOOLS.includes('builtin:edit'));
  assert.ok(SINGLE_AGENT_TOOLS.includes('builtin:view'));
  assert.ok(!SINGLE_AGENT_TOOLS.includes('custom:report_pass'));
});

test('cost per success includes inference spent on failed runs', () => {
  const runs = [
    {
      accepted: true,
      scenario: 's1',
      usage: { aiCredits: 10, inputTokens: 1000, calls: 5, elapsedMs: 1000, maxContextTokens: 100 },
      agents: [],
      reviewSignal: {},
    },
    {
      accepted: false,
      scenario: 's2',
      usage: { aiCredits: 8, inputTokens: 800, calls: 4, elapsedMs: 800, maxContextTokens: 80 },
      agents: [],
      reviewSignal: {},
    },
  ];
  const summary = aggregateTopology('candidate', runs);
  assert.equal(summary.successes, 1);
  assert.equal(summary.acceptanceRate, 0.5);
  assert.equal(summary.creditsPerSuccess, 18);
  assert.equal(summary.inputTokensPerSuccess, 1800);
});

test('Pareto frontier rewards correctness and lower accepted-result cost', () => {
  const groups = [
    { topology: 'cheap-flaky', successes: 1, acceptanceRate: 0.5, creditsPerSuccess: 10, inputTokensPerSuccess: 100 },
    { topology: 'good', successes: 2, acceptanceRate: 1, creditsPerSuccess: 12, inputTokensPerSuccess: 120 },
    { topology: 'expensive', successes: 2, acceptanceRate: 1, creditsPerSuccess: 20, inputTokensPerSuccess: 200 },
  ];
  assert.deepEqual(paretoFrontier(groups), ['cheap-flaky', 'good']);
});

test('tournament report requires complete topology run plus tests plus oracle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convergent-topology-report-'));
  const run = path.join(root, 'one');
  fs.mkdirSync(run);
  fs.writeFileSync(path.join(run, 'benchmark-meta.json'), JSON.stringify({
    topology: 'luna-terra',
    scenario: 'benchmarks/03-dependency-ordering.md',
    repeat: 1,
  }));
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({
    status: 'complete',
    topology: 'luna-terra',
    usage: { aiCredits: 4, inputTokens: 100, calls: 3, elapsedMs: 500, maxContextTokens: 90 },
  }));
  fs.writeFileSync(path.join(run, 'target-validation.json'), JSON.stringify({ ok: true }));
  fs.writeFileSync(path.join(run, 'scenario-acceptance.json'), JSON.stringify({ ok: false }));

  const rejected = buildTournamentReport(root);
  assert.equal(rejected.runs[0].accepted, false);

  fs.writeFileSync(path.join(run, 'scenario-acceptance.json'), JSON.stringify({ ok: true }));
  const accepted = buildTournamentReport(root);
  assert.equal(accepted.runs[0].accepted, true);
  assert.equal(accepted.topologies[0].acceptanceRate, 1);
});

test('tournament report extracts per-agent cost, tools, and review signal from full audit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convergent-topology-audit-'));
  const run = path.join(root, 'one');
  const audit = path.join(run, 'audit', 'run-1');
  fs.mkdirSync(audit, { recursive: true });
  fs.writeFileSync(path.join(run, 'benchmark-meta.json'), JSON.stringify({
    topology: 'luna-peer-terra',
    scenario: 'benchmarks/01-small-duration-parser.md',
    repeat: 2,
  }));
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({
    status: 'complete',
    topology: 'luna-peer-terra',
    usage: {
      aiCredits: 5,
      inputTokens: 500,
      calls: 8,
      elapsedMs: 1000,
      maxContextTokens: 120,
      agents: [
        { label: 'Worker A', model: 'GPT-5.6 Luna', calls: 4, inputTokens: 300, aiCredits: 0.5, durationMs: 500, maxContextTokens: 100 },
        { label: 'Peer critic', model: 'GPT-5.4 mini', calls: 2, inputTokens: 100, aiCredits: 1, durationMs: 200, maxContextTokens: 80 },
        { label: 'Strong reviewer', model: 'GPT-5.6 Terra', calls: 2, inputTokens: 100, aiCredits: 3.5, durationMs: 300, maxContextTokens: 90 },
      ],
    },
  }));
  fs.writeFileSync(path.join(run, 'target-validation.json'), JSON.stringify({ ok: true }));
  fs.writeFileSync(path.join(run, 'scenario-acceptance.json'), JSON.stringify({ ok: true }));
  fs.writeFileSync(path.join(audit, 'summary.json'), JSON.stringify({
    trajectory: {
      repeatedToolSignatureCount: 1,
      agents: {
        'Worker A': { systemPromptChars: 9000, promptChars: 1200, toolCalls: 4, tools: { batch_view: 1, apply_patch: 1, run_command: 1, report_pass: 1 } },
        'Peer critic': { systemPromptChars: 1700, promptChars: 4500, toolCalls: 2, tools: { batch_view: 1, report_review: 1 } },
        'Strong reviewer': { systemPromptChars: 6400, promptChars: 4700, toolCalls: 2, tools: { batch_view: 1, report_review: 1 } },
      },
    },
  }));
  fs.writeFileSync(path.join(audit, 'events.jsonl'), [
    JSON.stringify({ type: 'worker_pass_result', worker: 'A', changed: true, report: { findings: [] } }),
    JSON.stringify({ type: 'benchmark_peer_critic_result', verdict: 'findings', findings: [{ severity: 'medium' }] }),
    JSON.stringify({ type: 'worker_pass_result', worker: 'A', changed: true, report: { findings: [] } }),
    JSON.stringify({ type: 'strong_review_result', review: { verdict: 'findings', findings: [{ severity: 'low' }] } }),
  ].join('\n'));

  const loaded = loadRun(path.join(run, 'result.json'));
  assert.equal(loaded.agents.length, 3);
  assert.equal(loaded.agents[0].label, 'Worker A');
  assert.equal(loaded.agents[0].systemPromptChars, 9000);
  assert.equal(loaded.agents[1].label, 'Peer critic');
  assert.equal(loaded.agents[1].toolCalls, 2);
  assert.equal(loaded.reviewSignal.peerCriticFindings, 1);
  assert.equal(loaded.reviewSignal.strongReviewFindings, 1);
  assert.equal(loaded.reviewSignal.remediationPasses, 1);
  assert.equal(loaded.reviewSignal.repeatedToolSignatureCount, 1);

  const report = buildTournamentReport(root);
  const topology = report.topologies[0];
  assert.equal(topology.agentRoles.find((role) => role.label === 'Peer critic').medianCredits, 1);
  assert.equal(topology.reviewSignal.peerCriticFindings, 1);
  assert.equal(topology.reviewSignal.strongReviewFindings, 1);
});
