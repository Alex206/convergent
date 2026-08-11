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

function coordinatorFlowInstructions(mode) {
  const flow = normalizeFlowMode(mode);
  if (flow !== 'fast') return '';
  return [
    'FAST FLOW PLANNING: the user explicitly prefers a short accepted-result trajectory.',
    'When the request is already concrete, perform at most one bounded repository-inspection batch sufficient to identify project conventions and routing risk, then submit the proportionate plan.',
    'Prefer directly relevant root instructions/manifests/files over broad whole-repository pattern searches. Do not perform a second reassurance inspection wave after you already have enough evidence to plan.',
    'When several small relevant files are already known, inspect them in one parallel/batched tool roundtrip when the available tools permit it instead of paying a separate model continuation for each file.',
    'Do not inspect unrelated editor settings, caches, or other dirty/untracked workspace artifacts unless they materially affect the requested task.',
    'Minimize task count because every modifying task creates fresh A/B sessions and a fresh strong-review gate. A cohesive feature that changes a model, parser/implementation, exports, and its focused tests should normally be ONE modifying task when those changes must land together to satisfy one user-visible outcome.',
    'For Fast, target at most three total plan tasks. Exceed three only when the user explicitly requested genuinely independent deliverables that cannot be safely reviewed as acceptance-boundary tasks; never split implementation from the tests required to accept that same implementation just to create smaller file-oriented tasks.',
    'Repository inspection performed during planning is coordinator work, not a separate read_only plan task inside a modifying request. Split tasks only when they are independently acceptable/reviewable, have a real sequencing boundary, or require materially different risk treatment.',
    'Concrete anti-pattern: WRONG = task 1 "inspect files/symbols" as read_only plus task 2 "implement feature". RIGHT = one modifying task whose inspectionHints carry the relevant files/symbols already discovered during planning. A read_only task inside a modifying request is appropriate only when the user explicitly requested that read-only result as an independent deliverable.',
    'Every inspectionHints entry MUST be repository-relative (for example taskflow/config.py or tests/test_config.py). Never put an absolute workspace path such as /home/.../repo/file or C:\\...\\repo\\file into inspectionHints.',
  ].join(' ');
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
    'Use the repository-established validation framework/command when it is already evident from manifests or existing tests; do not probe alternative test runners or install missing tooling merely for reassurance.',
    'Do not inspect Copilot/Convergent runtime session-state directories or other agent-internal storage as a substitute for reviewing the task workspace.',
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

module.exports = {
  FLOW_MODES,
  normalizeFlowMode,
  flowPolicy,
  coordinatorFlowInstructions,
  workerFlowInstructions,
  reviewerFlowInstructions,
};
