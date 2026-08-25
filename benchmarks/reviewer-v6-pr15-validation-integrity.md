# Validation-integrity review contract

Review the frozen repository as a production correctness audit. Do not modify or remediate the workspace.

Focus on the deterministic report/validation integrity boundary: the system must distinguish **current unresolved validation prerequisites** from descriptions of validation behavior that has already been exercised successfully.

Required semantics:

- A report is BLOCKED only when its current structured evidence contains a genuine unresolved required/external validation condition or operator prerequisite.
- Successful required/external validation evidence must remain successful evidence; merely describing a tested negative/error path must not reinterpret the current run as blocked.
- Descriptions of expected missing-credential/error behavior in tests are evidence about the behavior under test, not automatically evidence that the current validator invocation lacks that prerequisite.
- Conversely, wording that genuinely states a required validator is unavailable, failed, non-zero, or lacks a required credential must remain blocking even if some other check succeeded.
- Explicit `BLOCKED:` evidence and genuine unresolved named-credential prerequisites must continue to fail closed.
- CLEAN/CHANGED reports must be reconciled to BLOCKED when their own current evidence really contains such an unresolved validation blocker; benign negative-case coverage must not cause that reconciliation.
- Classification should depend on the semantic validation state rather than accidental word collisions in prose, while remaining conservative for ambiguous genuinely unresolved prerequisites.

Inspect the complete directly affected implementation, callers/contracts, and relevant tests. Challenge the classifier with concrete contrasting witnesses rather than relying only on existing tests or individual keywords. Return only actionable evidence-based defects; otherwise report CLEAN.
