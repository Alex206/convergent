'use strict';

const FLOW_MODES = new Set(['fast', 'auto', 'thorough']);

const REVIEW_QUALITY_CONTRACT = [
  'REVIEW QUALITY CONTRACT: before CLEAN, derive a compact acceptance matrix from the explicit task requirements and directly affected repository contracts. For each criterion, distinguish implementation evidence from validation/test evidence; an existing or passing test is not proof that it actually exercises the requirement.',
  'For type, shape, default, error, and boundary contracts, challenge materially distinct states implied by the task instead of checking only representative happy paths.',
  'For algorithmic behavior or a global semantic invariant that is central to correctness, attempt to falsify the implementation with one bounded property-oriented check or multiple structurally distinct witnesses when the supplied evidence does not already discriminate the invariant from plausible near-miss implementations. Prefer one decisive probe over broad retesting.',
  'On remediation cycles, re-check previous findings and every acceptance criterion materially affected by the remediation. If algorithmic or semantic behavior changed, use a fresh witness or property check before CLEAN; do not rely only on replaying the original failing example.',
  'Collect all independently discoverable actionable findings within the selected bounded scope. Do not invent hidden requirements, and do not broaden beyond the task and directly affected contracts merely to satisfy this contract.',
].join(' ');

const TRUST_BOUNDARY_COMPOSITION_CONTRACT = [
  'BENCHMARK TRUST-BOUNDARY COMPOSITION REVIEW: when the task transforms untrusted or externally controlled input across a security/trust boundary, do not establish safety only from the final normalized, canonical, decoded, redirected, aliased, resolved, or otherwise transformed representation.',
  'Trace the relevant transformations in execution order and, before CLEAN, choose one bounded discriminating adversarial witness where an intermediate state crosses, escapes, or rebinds the trust boundary and a later transformation could make the final representation appear acceptable.',
  'Also choose one bounded benign witness from the same transformation family whose representation changes but whose behavior is explicitly or directly implied to remain valid. The pair should distinguish both a final-state-only near miss and an over-restrictive remediation.',
  'If either witness contradicts the required boundary or allowed behavior, report a finding. Derive the trust boundary and allowed behavior only from the explicit task and directly affected repository contracts; do not invent hidden requirements.',
].join(' ');

function benchmarkReviewerInstructions() {
  return process.env.CONVERGENT_BENCHMARK_REVIEW_CONTRACT === 'trust-boundary-composition-v1'
    ? TRUST_BOUNDARY_COMPOSITION_CONTRACT
    : '';
}

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
    'Use custom batch_view as the PRIMARY Fast discovery tool. In one call, put all known symbol/literal questions in queries, useful tracked-file patterns in globs, and set readMatches=true so the discovered files are returned immediately. This replaces serial grep/rg/glob/view loops.',
    'Concrete discovery anti-pattern: WRONG = grep symbol A, grep symbol B, glob files, view file A, view file B across separate model continuations. RIGHT = one batch_view call such as queries=["class TaskSpec","def parse_tasks","class ConfigError"], globs=["taskflow/*.py","tests/test_*.py"], readMatches=true, then report_plan when that evidence is sufficient.',
    'Use builtin grep/rg/glob/view only if one batch_view result leaves a specific unresolved question that cannot be answered from its searches/globs/files. Do not perform a second reassurance inspection wave after you already have enough evidence to plan.',
    'Do not inspect unrelated editor settings, caches, or other dirty/untracked workspace artifacts unless they materially affect the requested task.',
    'Minimize task count because every modifying task creates fresh A/B sessions and a fresh strong-review gate. A cohesive feature that changes a model, parser/implementation, exports, and its focused tests should normally be ONE modifying task when those changes must land together to satisfy one user-visible outcome.',
    'For Fast, target at most three total plan tasks. Exceed three only when the user explicitly requested genuinely independent deliverables that cannot be safely reviewed as acceptance-boundary tasks; never split implementation from the tests required to accept that same implementation just to create smaller file-oriented tasks.',
    'Repository inspection performed during planning is coordinator work, not a separate read_only plan task inside a modifying request. Split tasks only when they are independently acceptable/reviewable, have a real sequencing boundary, or require materially different risk treatment.',
    'Concrete planning anti-pattern: WRONG = task 1 "inspect files/symbols" as read_only plus task 2 "implement feature". RIGHT = one modifying task whose description includes the concise current-repository facts already learned and whose inspectionHints identify the relevant existing files/symbols. A read_only task inside a modifying request is appropriate only when the user explicitly requested that read-only result as an independent deliverable.',
    'Every inspectionHints entry MUST be repository-relative (for example taskflow/config.py or tests/test_config.py) and MUST refer to an existing repository surface you actually observed. Never put an absolute workspace path or a proposed/new file into inspectionHints; planned new files belong in the task description or acceptance criteria.',
    'When planning inspected concrete implementation details for a modifying task, include a short "Current repository facts:" paragraph directly in that task description: relevant existing functions/classes, current conventions, important field/key sets, existing test layout, and other factual findings that can save Worker A from re-discovering the same information. Keep it bounded and do not paste raw tool transcripts.',
  ].join(' ');
}

function workerFlowInstructions(mode) {
  const flow = normalizeFlowMode(mode);
  if (flow !== 'fast') return '';
  return [
    'FAST FLOW: optimize for time and accepted-result cost, not exhaustive exploration.',
    'Use one focused inspection of the changed/task-relevant surface, make the smallest complete change, run only decisive checks, and finish the pass.',
    'Treat concrete current-repository facts already present in the task description as reusable planning evidence: use those facts directly unless exact source text is needed to edit safely or a fact is uncertain. inspectionHints are locators for existing observed surfaces, not a checklist requiring every file to be reopened.',
    'When exact text from multiple known existing files is needed, use custom batch_view once with those paths. If one or more locations are still unknown, include all literal queries/globs in that same batch_view call and set readMatches=true. Do not spend one model continuation per builtin:view/grep/glob call.',
    'Batch related edits/creates into one apply_patch call when practical, including multiple files in the same patch. WRONG = one edit tool call and model continuation per file when the whole change is already understood. RIGHT = one coordinated patch, then one decisive validation step.',
    'When a peer report already names the relevant changed files or exact checks, use that information directly; do not rediscover the same files with glob/search unless the report is incomplete or a concrete concern requires it.',
    'Do not re-read files or rerun successful checks unless a concrete new concern or later edit invalidates the earlier evidence. In particular, do not rerun an exact check that the peer already passed on the current workspace fingerprint merely for independent reassurance.',
    'Use the repository-established validation framework/command when it is already evident from manifests or existing tests; do not probe alternative test runners or install missing tooling merely for reassurance.',
    'Do not inspect Copilot/Convergent runtime session-state directories or other agent-internal storage as a substitute for reviewing the task workspace.',
    'If a broader investigation appears necessary, report the concrete reason rather than silently expanding into an open-ended repository audit.',
  ].join(' ');
}

function reviewerFlowInstructions(mode) {
  const flow = normalizeFlowMode(mode);
  let scope;
  if (flow === 'fast') {
    scope = [
      'FAST FLOW REVIEW SCOPE: on the first cycle focus on the task diff/current changed files, acceptance criteria, and directly affected interfaces/tests. Do not perform a whole-repository audit.',
      'When several exact changed/relevant files need inspection, use custom batch_view once rather than serial builtin:view calls; if locations are uncertain, combine the queries/globs and readMatches=true in that same call.',
      'Use worker validation evidence on the exact current workspace fingerprint instead of mechanically rerunning the same successful check. Run independent validation when a concrete correctness concern or a central semantic invariant lacks discriminating evidence; otherwise avoid reassurance-only reruns.',
      'Do not spend tool calls discovering unrelated dirty/untracked workspace state. A path is an out-of-scope task finding only when there is evidence this task introduced or modified it.',
    ].join(' ');
  } else if (flow === 'thorough') {
    scope = 'THOROUGH FLOW REVIEW SCOPE: on the first cycle perform a comprehensive task-level review including architecture, affected contracts, regressions, and critical validation appropriate to the risk.';
  } else {
    scope = 'AUTO FLOW REVIEW SCOPE: on the first cycle review the task diff plus directly affected architecture/contracts/test surfaces; broaden only when risk or concrete evidence warrants it.';
  }
  return [scope, REVIEW_QUALITY_CONTRACT, benchmarkReviewerInstructions()].filter(Boolean).join(' ');
}

module.exports = {
  FLOW_MODES,
  normalizeFlowMode,
  flowPolicy,
  coordinatorFlowInstructions,
  workerFlowInstructions,
  reviewerFlowInstructions,
};
