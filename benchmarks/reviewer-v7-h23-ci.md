# Headless benchmark CI acceptance review

Review the frozen repository as a production correctness audit. Do not modify or remediate the workspace.

The optional headless benchmark CI path exists to provide trustworthy acceptance evidence for candidate changes without making ordinary PR CI consume inference.

Required behavior:

- When the benchmark path is not enabled, ordinary CI may skip benchmark-specific work.
- When enabled, a candidate counts as accepted only if the benchmark execution completes, independent target validation succeeds, and the registered deterministic scenario acceptance oracle succeeds.
- A failed authoritative acceptance condition must make the GitHub job fail; diagnostic convenience must not turn an invalid candidate green.
- Failed runs should still retain enough evidence for diagnosis. Final status/diff/workspace capture and artifact upload should run where safely possible even after earlier benchmark failure.
- Best-effort diagnostics such as efficiency summarization may fail without masking the authoritative result.
- Shell/pipeline behavior must preserve the actual status of authoritative tests and oracle processes.

Inspect the workflow control flow and any directly relevant scripts. Reason about both successful and failing benchmark executions. Return only actionable correctness defects that can produce a false green, false acceptance, or loss of required failure evidence; otherwise report CLEAN.
