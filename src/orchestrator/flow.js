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
      description: 'Reach a reviewed result quickly: focused inspection, proportionate adaptive implementation, short A/B convergence, and one automatic remediation + delta re-review before asking to spend more.',
      maxWorkerPasses: Math.min(workerPasses, 3),
      // Two review calls means: initial finding sweep, then one remediation/delta re-review.
      // Asking after the first finding would make Fast unnecessarily interactive.
      maxReviewerCycles: Math.min(Math.max(reviewerCycles, 2), 2),
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
    'Batch related edits/creates into one apply_patch call when practical instead of paying a separate model roundtrip for each file.',
    'When a peer report already names the relevant changed files or exact checks, use that information directly; do not rediscover the same files with glob/search unless the report is incomplete or a concrete concern requires it.',
    'Do not re-read files or rerun successful checks unless a concrete new concern or later edit invalidates the earlier evidence. In particular, do not rerun an exact check that the peer already passed on the current workspace fingerprint merely for independent reassurance.',
    'If a broader investigation appears necessary, report the concrete reason rather than silently expanding into an open-ended repository audit.',
  ].join(' ');
}

function reviewerFlowInstructions(mode) {
  const flow = normalizeFlowMode(mode);
  if (flow === 'fast') {
    return [
      'FAST FLOW REVIEW SCOPE: on the first cycle focus on the task diff/current changed files, acceptance criteria, and directly affected interfaces/tests. Do not perform a whole-repository audit.',
      'Use worker validation evidence on the exact current workspace fingerprint instead of mechanically rerunning the same successful check. Run independent validation only when you first identify a concrete correctness concern that the existing evidence does not answer.',
      'Do not spend tool calls discovering unrelated dirty/untracked workspace state. A path is an out-of-scope task finding only when there is evidence this task introduced or modified it.',
    ].join(' ');
  }
  if (flow === 'thorough') {
    return 'THOROUGH FLOW REVIEW SCOPE: on the first cycle perform a comprehensive task-level review including architecture, affected contracts, regressions, and critical validation appropriate to the risk.';
  }
  return 'AUTO FLOW REVIEW SCOPE: on the first cycle review the task diff plus directly affected architecture/contracts/test surfaces; broaden only when risk or concrete evidence warrants it.';
}

module.exports = { FLOW_MODES, normalizeFlowMode, flowPolicy, workerFlowInstructions, reviewerFlowInstructions };