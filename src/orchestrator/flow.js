'use strict';

const FLOW_MODES = new Set(['fast', 'auto', 'thorough']);

function normalizeFlowMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return FLOW_MODES.has(normalized) ? normalized : 'auto';
}

function flowPolicy(mode, config = {}) {
  const flow = normalizeFlowMode(mode);
  const workerPasses = Math.max(2, Math.floor(Number(config.maxWorkerPasses) || 8));
  const reviewerCycles = Math.max(1, Math.floor(Number(config.maxReviewerCycles) || 3));

  if (flow === 'fast') {
    return {
      mode: flow,
      label: 'Fast',
      description: 'Reach a reviewed result quickly: focused inspection, short A/B and strong-review tranches, then ask before spending more.',
      maxWorkerPasses: Math.min(workerPasses, 3),
      maxReviewerCycles: 1,
      reviewerScope: 'task-diff',
    };
  }

  if (flow === 'thorough') {
    return {
      mode: flow,
      label: 'Thorough',
      description: 'Favor assurance over speed: broader first review and larger autonomous convergence/review tranches.',
      maxWorkerPasses: Math.max(workerPasses, 8),
      maxReviewerCycles: Math.max(reviewerCycles, 3),
      reviewerScope: 'comprehensive',
    };
  }

  return {
    mode: 'auto',
    label: 'Auto',
    description: 'Balanced adaptive workflow with task/risk-based models and bounded review tranches.',
    maxWorkerPasses: workerPasses,
    maxReviewerCycles: reviewerCycles,
    reviewerScope: 'affected-surfaces',
  };
}

function workerFlowInstructions(mode) {
  const flow = normalizeFlowMode(mode);
  if (flow !== 'fast') return '';
  return [
    'FAST FLOW: optimize for time and accepted-result cost, not exhaustive exploration.',
    'Use one focused inspection of the changed/task-relevant surface, make the smallest complete change, run only decisive checks, and finish the pass.',
    'Do not re-read files or rerun successful checks unless a concrete new concern or later edit invalidates the earlier evidence.',
    'If a broader investigation appears necessary, report the concrete reason rather than silently expanding into an open-ended repository audit.',
  ].join(' ');
}

function reviewerFlowInstructions(mode) {
  const flow = normalizeFlowMode(mode);
  const common = [
    'FINDING COLLECTION RULE: do not stop the review merely because you found the first actionable defect. Continue the bounded review scope and report all independently discoverable actionable findings together in one report_review call.',
    'On later review cycles, verify every previous finding first, then review the remediation delta and directly affected callers/tests/interfaces. Do not redo the entire original review unless the remediation materially expanded scope or architecture.',
  ];

  if (flow === 'fast') {
    return [
      ...common,
      'FAST FLOW FIRST REVIEW: focus on the task diff/current changed files, acceptance criteria, and directly affected interfaces/tests. Do not perform a whole-repository audit.',
    ].join(' ');
  }
  if (flow === 'thorough') {
    return [
      ...common,
      'THOROUGH FLOW FIRST REVIEW: perform a comprehensive task-level review including architecture, affected contracts, regressions, and critical validation appropriate to the risk.',
    ].join(' ');
  }
  return [
    ...common,
    'AUTO FLOW FIRST REVIEW: review the task diff plus directly affected architectural/contracts/test surfaces; broaden only when risk or concrete evidence warrants it.',
  ].join(' ');
}

module.exports = { FLOW_MODES, normalizeFlowMode, flowPolicy, workerFlowInstructions, reviewerFlowInstructions };
