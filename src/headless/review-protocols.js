'use strict';

const REVIEW_PROTOCOLS = Object.freeze({
  contract: Object.freeze({
    label: 'Contract / requirements',
    charter: `
Own requirement and contract conformance only.
- Map each task requirement and acceptance criterion to concrete implementation behavior.
- Check both positive obligations (what must remain allowed/work) and negative obligations (what must be rejected/prevented).
- When requirements compose, inspect precedence, tie-breaking, boundary semantics, and cases where satisfying one clause can accidentally violate another.
- Trace the changed implementation to directly affected public/internal contracts and report concrete mismatches, omissions, or unintended strengthening/weakening.
- Prefer a minimal counterexample or exact code path over general concern.
Do not spend review budget on style or unrelated implementation quality.
`.trim(),
  }),
  adversarial: Object.freeze({
    label: 'Adversarial / error guessing',
    charter: `
Own falsification and error-guessing review only.
- Identify important assumptions made by the changed implementation and try to make each false.
- Exercise boundary values, malformed-but-plausible input, repeated operations, unusual ordering/composition, partial failure, retry/cancellation, and surprising combinations of otherwise valid operations when relevant.
- Do not infer correctness only from the final state; consider whether an invariant can be violated during an intermediate step and later appear restored.
- Prefer concrete witnesses/execution traces that would distinguish correct from incorrect behavior.
- Report only actionable defects supported by repository evidence.
Do not perform a broad architecture or style review.
`.trim(),
  }),
  'state-dataflow': Object.freeze({
    label: 'State / data-flow',
    charter: `
Own state, data-flow, provenance, and lifecycle invariants only.
- Follow important values and state through the changed execution path, including transformations, aliases, caches, ownership changes, error paths, and cleanup.
- Check invariants at intermediate transitions, not only at function entry/exit or final persisted state.
- Look for stale state, lost provenance, invalid transition ordering, inconsistent duplicated state, incorrect default/fallback state, and failure paths that leave state partially updated.
- When reporting a defect, give the shortest concrete state/value trace that demonstrates it.
Do not duplicate general requirements or style review unless needed to establish the state invariant.
`.trim(),
  }),
  'integration-compatibility': Object.freeze({
    label: 'Integration / compatibility',
    charter: `
Own compatibility and integration impact only.
- Inspect directly affected callers, callees, public/internal interfaces, serialization/schema boundaries, persisted state, configuration, build/package surfaces, platform assumptions, and upgrade/downgrade behavior when relevant.
- Look for changes that work locally but break an established caller, previous valid input, platform, migration path, or externally visible contract.
- Check that tests cover compatibility-sensitive behavior rather than only the new happy path.
- Prefer specific broken consumers/contracts over speculative future concerns.
Do not broaden into unrelated repository cleanup.
`.trim(),
  }),
  'security-trust': Object.freeze({
    label: 'Security / trust boundaries',
    charter: `
Own security and trust-boundary review only.
- Identify untrusted or less-trusted inputs, identities, files/paths, environment/configuration, external responses, persisted data, and privilege boundaries touched by the change.
- Check authorization, validation-before/after-transformation, injection, traversal/aliasing, TOCTOU, provenance loss, secret exposure, privilege confusion, unsafe defaults, and fail-open behavior when relevant.
- Follow data across every trust-boundary transition instead of validating only the final representation.
- Require a concrete attack/failure path or violated security invariant for each finding.
Do not report generic hardening ideas that are outside the task or unsupported by evidence.
`.trim(),
  }),
  'concurrency-resources': Object.freeze({
    label: 'Concurrency / resources',
    charter: `
Own concurrency, atomicity, idempotence, and resource-lifecycle review only.
- Examine shared mutable state, process/thread overlap, reentrancy, lock ordering, atomic publication, retries, duplicate execution, cancellation, and crash/failure boundaries when relevant.
- Track ownership and lifetime of files, handles, locks, temporary state, network resources, subprocesses, and other acquired resources.
- Look for partial visibility, double-use/double-free, orphaned locks/resources, non-idempotent retries, races between validation and use, and cleanup that changes correctness.
- Report a concrete interleaving or lifecycle trace whenever possible.
Do not invent concurrency risk where the changed code has no relevant shared/resource behavior.
`.trim(),
  }),
});

const REVIEW_PROTOCOL_IDS = Object.freeze(Object.keys(REVIEW_PROTOCOLS));
const MAX_SELECTED_PROTOCOLS = 3;

const GENERIC_LUNA_REVIEW_PROMPT = `
You are one independent read-only Luna reviewer in a review panel. Perform a normal bounded code review of the exact task changes against the task and acceptance criteria.

Look for concrete correctness, regression, error-handling, compatibility, security, concurrency, scope, and test defects that matter to this task. Inspect the changed code plus only directly affected context. Prefer precise actionable findings over speculative commentary. Do not edit files and do not coordinate with or assume conclusions from other reviewers.

Call report_review exactly once. CLEAN requires findings=[]; FINDINGS contains only unresolved actionable findings; BLOCKED is only for a substantive inability to establish correctness.
`.trim();

const REVIEW_CONTROLLER_PROMPT = `
You are Convergent's read-only Terra review controller for one benchmark task. You have two distinct phases.

PLANNING PHASE:
- Select exactly the requested number of reusable review protocols from the supplied fixed catalog.
- Select protocols because their generic defect-search perspective is relevant to the task/change, not because of benchmark-specific knowledge.
- Do not invent new protocols and do not encode expected bugs, hidden tests, or scenario-specific witnesses.
- Inspect only enough repository context to choose complementary perspectives.
- Call report_review_plan exactly once.

ADJUDICATION PHASE:
- Read the independent Luna reviewer reports as evidence, not votes. One well-supported defect can invalidate the change even when every other reviewer is clean.
- Resolve duplicates/contradictions and validate questionable findings with small targeted read-only inspection when needed.
- Judge whether the selected perspectives collectively covered the important risk surface. You may report a concrete uncovered defect you can establish during adjudication, but do not redo a broad generic review from scratch.
- Call report_review exactly once with the final actionable findings.

Never edit files. Keep both phases bounded and evidence-oriented.
`.trim();

function formatReviewProtocolCatalog() {
  return REVIEW_PROTOCOL_IDS.map((id) => {
    const protocol = REVIEW_PROTOCOLS[id];
    return `- ${id}: ${protocol.label}\n${protocol.charter.split('\n').map((line) => `  ${line}`).join('\n')}`;
  }).join('\n');
}

function normalizeReviewPlan(args = {}) {
  const selected = (Array.isArray(args.selected) ? args.selected : [args.selected])
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean);
  return {
    selected,
    rationale: String(args.rationale ?? '').trim(),
  };
}

function validateReviewPlan(plan, { expectedCount = MAX_SELECTED_PROTOCOLS } = {}) {
  if (!plan.rationale) return 'Review plan rationale is required.';
  if (plan.selected.length !== expectedCount) {
    return `Review plan must select exactly ${expectedCount} protocol(s).`;
  }
  const unique = new Set(plan.selected);
  if (unique.size !== plan.selected.length) return 'Review plan protocols must be unique.';
  for (const id of plan.selected) {
    if (!Object.hasOwn(REVIEW_PROTOCOLS, id)) return `Unknown review protocol: ${id}.`;
  }
  return null;
}

function createReviewPlanTool(defineTool, sink, { expectedCount = MAX_SELECTED_PROTOCOLS } = {}) {
  return defineTool('report_review_plan', {
    description: 'Select the fixed reusable review protocols that independent Luna reviewers should apply to the current change.',
    parameters: {
      type: 'object',
      properties: {
        selected: {
          type: 'array',
          minItems: expectedCount,
          maxItems: expectedCount,
          uniqueItems: true,
          items: { type: 'string', enum: REVIEW_PROTOCOL_IDS },
        },
        rationale: { type: 'string' },
      },
      required: ['selected', 'rationale'],
      additionalProperties: false,
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args) => {
      const plan = normalizeReviewPlan(args);
      const error = validateReviewPlan(plan, { expectedCount });
      if (error) return { accepted: false, error, retry: true };
      sink.value = plan;
      return { accepted: true, selected: plan.selected };
    },
  });
}

function perspectiveSystemPrompt(protocolId) {
  const protocol = REVIEW_PROTOCOLS[protocolId];
  if (!protocol) throw new Error(`Unknown review protocol ${protocolId}.`);
  return `
You are an independent read-only Luna reviewer assigned exactly one reusable review perspective: ${protocol.label}.

${protocol.charter}

Independence rules:
- Do not assume another reviewer will cover an issue inside your assigned perspective.
- Do not try to cover every possible review dimension; stay focused so the panel gains complementary search behavior.
- Do not use benchmark names, hidden-oracle assumptions, or scenario-specific expected answers.
- Inspect the exact task change first and only the surrounding code required by this perspective.
- Do not edit files.

Call report_review exactly once. CLEAN requires findings=[]; FINDINGS contains only unresolved actionable findings; BLOCKED is only for a substantive inability to establish correctness. Put concrete checks/witnesses actually performed in checks.
`.trim();
}

function formatPanelReports(reports = []) {
  if (!reports.length) return 'No panel reports were produced.';
  return reports.map((entry, index) => {
    const findings = entry.report?.findings?.length
      ? entry.report.findings.map((finding) => `  - [${finding.severity}] ${finding.title}${finding.file ? ` (${finding.file})` : ''}: ${finding.description}`).join('\n')
      : '  - none';
    const checks = entry.report?.checks?.length
      ? entry.report.checks.map((check) => `  - ${check}`).join('\n')
      : '  - none';
    return [
      `${index + 1}. Reviewer: ${entry.label}`,
      `   verdict: ${entry.report?.verdict ?? 'missing'}`,
      `   summary: ${entry.report?.summary ?? ''}`,
      '   findings:',
      findings,
      '   checks:',
      checks,
    ].join('\n');
  }).join('\n\n');
}

module.exports = {
  REVIEW_PROTOCOLS,
  REVIEW_PROTOCOL_IDS,
  MAX_SELECTED_PROTOCOLS,
  GENERIC_LUNA_REVIEW_PROMPT,
  REVIEW_CONTROLLER_PROMPT,
  formatReviewProtocolCatalog,
  normalizeReviewPlan,
  validateReviewPlan,
  createReviewPlanTool,
  perspectiveSystemPrompt,
  formatPanelReports,
};
