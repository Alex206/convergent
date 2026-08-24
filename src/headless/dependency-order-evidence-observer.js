'use strict';

const { taskContractText } = require('./evidence-observers');
const {
  DEPENDENCY_ORDER_PROBE_TOOL,
  REVIEWER_DEPENDENCY_ORDER_PROMPT,
  createDependencyOrderProbeTool,
} = require('./reviewer-dependency-order-probe');

const DEPENDENCY_ORDER_OBSERVER_ID = 'dependency-order-ready-transition-v1';
const MAX_AUDITOR_DEPENDENCY_OBSERVATIONS = 4;

const DEPENDENCY_ORDER_AUDIT_CONTRACT = Object.freeze({
  id: 'dependency-order-evidence-v1',
  prompt: `
You are a tiny semantic quality gate for another model's code-review report. You do NOT review the code and you have no repository access. Judge only whether the strong review report explicitly demonstrates the central dependency-ordering contract using the supplied current-revision programmatic evidence. Never infer that a check happened unless the report records it.

For a CLEAN dependency-order review, mark each aspect true only when concrete performed evidence supports it:
1. dependency_edges_observed — a nontrivial acyclic graph was exercised and its returned order respects declared dependency edges.
2. stable_ready_choice_observed — the evidence records ready-set transitions and the implementation chooses the earliest currently-ready task by original input order at the observed decision points.
3. mixed_ready_transition_observed — at least one witness has a genuinely mixed ready set (two or more candidates while dependency completion changes readiness), rather than only a chain or an all-independent list.
4. all_tasks_preserved_observed — a successful graph result is a permutation of the input tasks; no task is dropped or duplicated.
5. cycle_rejection_observed — a genuine cyclic graph was exercised and the implementation rejected it rather than returning an order.
6. cycle_names_observed — the recorded cycle error names the cycle tasks needed to make the diagnostic useful.
7. discriminating_evidence — the evidence is actual current-revision programmatic observation, not generic test claims or a restatement of the implementation.

The programmatic observer does not encode an expected output list or hidden oracle. It reports the input graph, actual result, dependency relations, and ready-set facts. Derive adequacy from the TASK CONTRACT and those observations. A different graph witness is valid if it proves the same semantic property. Other task requirements such as parsing shape, public exports, and immutable model fields remain the strong reviewer's responsibility and are outside this narrow evidence gate.

Call report_review_audit exactly once. Keep missing_or_weak_aspects concise and actionable.
`.trim(),
  aspects: Object.freeze([
    ['dependency_edges_observed', 'exercise a nontrivial acyclic graph and show declared dependencies precede dependents'],
    ['stable_ready_choice_observed', 'show ready-set transitions preserve original input-order tie-breaking among currently ready tasks'],
    ['mixed_ready_transition_observed', 'exercise a mixed partial-order witness with competing ready tasks as dependencies unlock work'],
    ['all_tasks_preserved_observed', 'show a successful result preserves every input task exactly once'],
    ['cycle_rejection_observed', 'exercise and observe rejection of a genuine dependency cycle'],
    ['cycle_names_observed', 'show the cycle diagnostic names the involved tasks'],
    ['discriminating_evidence', 'use concrete current-revision programmatic graph observations rather than generic coverage claims'],
  ]),
  toolDescription: 'Assess whether a CLEAN dependency-order review explicitly demonstrates the required graph-order evidence. This tool does not review code.',
  feedbackInstructions: Object.freeze([
    'Use concrete graph witnesses and the programmatic ready-set transition facts. Do not repair an evidence gap by merely asserting an expected output list.',
    'For stable ordering, exercise a mixed partial-order case where dependency completion changes the ready set while unrelated work is also ready; chains and all-independent lists alone are not discriminating.',
  ]),
});

const REVIEW_AUDITOR_DEPENDENCY_PROMPT = `
The review report can contain a PROGRAMMATIC DEPENDENCY-ORDER EVIDENCE entry. It is authoritative bounded evidence captured from actual probe_dependency_order executions against the exact workspace revision being approved; it is not reviewer prose and it contains no hidden expected output ordering.

For stable-order claims, inspect each witness's ready_transition_trace. A mixed witness is discriminating only when at least one step has multiple ready candidates and the trace shows which candidate the implementation actually chose versus the earliest ready candidate in original input order. Do not credit a simple chain as evidence of stable tie-breaking because it has no choice point. Do not credit an all-independent list alone because it does not exercise readiness changes caused by dependencies.

For cycle claims, require a graph marked has_cycle=true, an observed rejection, and cycle task names present in the error. Set the dependency-order audit aspects true only when the current-revision programmatic evidence supports them.
`.trim();

function dependencyOrderObserverApplicability({ task } = {}) {
  const contract = taskContractText(task);
  const namesApi = /\border_tasks\b/.test(contract);
  const namesSemanticContract = /dependenc/.test(contract)
    && /deterministic|stable/.test(contract)
    && /input order|original order/.test(contract);
  if (!namesApi && !namesSemanticContract) {
    return { applicable: false, reason: 'task-contract-does-not-identify-dependency-order-semantics' };
  }
  return {
    applicable: true,
    reason: namesApi
      ? 'task-contract-identifies-order_tasks'
      : 'task-contract-identifies-stable-dependency-order-semantics',
  };
}

function compactDependencyEvidence(observations = [], revision, maxObservations = MAX_AUDITOR_DEPENDENCY_OBSERVATIONS) {
  const expectedRevision = String(revision ?? '');
  return (Array.isArray(observations) ? observations : [])
    .filter((entry) => entry?.revision === expectedRevision && entry?.spec && entry?.result)
    .slice(-Math.max(1, Number(maxObservations) || MAX_AUDITOR_DEPENDENCY_OBSERVATIONS))
    .map((entry, index) => ({
      id: `dependency-probe-${index + 1}`,
      cases: entry.spec.cases,
      results: entry.result.results,
    }));
}

function augmentReviewWithDependencyEvidence(review, evidence, revision) {
  const checks = Array.isArray(review?.checks) ? review.checks : [];
  const payload = {
    workspace_revision: String(revision ?? '').slice(0, 16),
    source: 'captured probe_dependency_order tool executions on this exact revision',
    observations: evidence,
  };
  return {
    ...review,
    checks: [
      ...checks,
      `PROGRAMMATIC DEPENDENCY-ORDER EVIDENCE (authoritative; current revision only): ${JSON.stringify(payload)}`,
    ],
  };
}

function createDependencyOrderEvidenceObserver() {
  return Object.freeze({
    id: DEPENDENCY_ORDER_OBSERVER_ID,
    schemaVersion: 1,
    evidenceType: 'graph.dependency-order-ready-transition',
    toolName: DEPENDENCY_ORDER_PROBE_TOOL,
    reviewerPrompt: REVIEWER_DEPENDENCY_ORDER_PROMPT,
    auditorPrompt: REVIEW_AUDITOR_DEPENDENCY_PROMPT,
    auditContract: DEPENDENCY_ORDER_AUDIT_CONTRACT,
    metadata: Object.freeze({
      oracleBlind: true,
      revisionBound: true,
      typedTransitions: true,
      repositoryWrites: false,
      graphReadySetEvidence: true,
    }),
    applicability(context) {
      return dependencyOrderObserverApplicability(context);
    },
    createTool({ defineTool, workspace, observationSink }) {
      return createDependencyOrderProbeTool(defineTool, { workspace, observationSink });
    },
    compactEvidence(observations, revision) {
      return compactDependencyEvidence(observations, revision);
    },
    augmentReview(review, evidence, revision) {
      return augmentReviewWithDependencyEvidence(review, evidence, revision);
    },
  });
}

module.exports = {
  DEPENDENCY_ORDER_OBSERVER_ID,
  MAX_AUDITOR_DEPENDENCY_OBSERVATIONS,
  DEPENDENCY_ORDER_AUDIT_CONTRACT,
  REVIEW_AUDITOR_DEPENDENCY_PROMPT,
  dependencyOrderObserverApplicability,
  compactDependencyEvidence,
  augmentReviewWithDependencyEvidence,
  createDependencyOrderEvidenceObserver,
};
