# CI acceptance-gate review contract

Review the frozen repository as a production correctness audit. Do not modify or remediate the workspace.

Focus on CI control-flow semantics for optional headless benchmark validation.

Required semantics:

- When the headless benchmark path is enabled, independent target tests and the deterministic acceptance oracle are authoritative acceptance gates. A non-zero result from either must make the GitHub job fail.
- Diagnostic summarization and evidence capture are not acceptance gates. They may be best-effort and must not turn a failed acceptance check into a successful job.
- Evidence upload should still be attempted after benchmark or acceptance failure so failed runs remain diagnosable.
- The optional benchmark path may remain skipped when it was not requested/enabled.
- Shell pipelines used by authoritative validation must preserve non-zero failure status rather than accidentally returning the status of a logging command.
- Do not report style, naming, or speculative hardening. Return only concrete defects that can make CI accept an invalid benchmark result or lose required failure evidence; otherwise report CLEAN.

Inspect the directly relevant workflow steps and any scripts needed to establish the actual failure/continuation behavior. Challenge the control flow with a concrete failing-oracle witness rather than treating a green workflow definition as proof of correctness.
