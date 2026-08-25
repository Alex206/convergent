# Deterministic report-integrity subsystem review

Review the frozen repository as a production correctness audit. Do not modify or remediate the workspace.

This subsystem owns deterministic integrity around structured agent reports, required/external validation, recovery prerequisites, and revision-scoped validation evidence.

Required behavior:

- Structured worker/reviewer verdicts and their own evidence must not allow a modifying task to be accepted while a genuinely required validation prerequisite remains unresolved.
- Successful required-validation evidence is meaningful only for the validator and exact workspace revision it actually validated; changed revisions or different validators require fresh evidence.
- A later pass must not invalidate authoritative same-revision evidence merely by making a weaker or context-poor observation about the same validator.
- Explicit unresolved operator prerequisites and denied credential-provenance violations remain fail-closed.
- Conversely, deterministic reconciliation must not invent a blocker from evidence that is already resolved or from ordinary descriptions of tested behavior.
- Contradictory structured reports may be corrected only when the report's concrete evidence makes the correction safe; ambiguous cases must remain conservative.
- The boundary must work consistently for worker, peer, reviewer, recovery, and resume paths that consume these reports.

Inspect the relevant implementation, its direct callers, and focused tests. Construct concrete contrasting report/evidence examples where useful. Return only actionable correctness defects supported by repository evidence; otherwise report CLEAN.
