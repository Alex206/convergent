# Changelog

All notable Convergent changes are documented here. Released versions are dated; development candidates remain marked `Unreleased` until an explicit merge/tag/release decision is made.

## [0.3.0] - 2026-08-15

### Adaptive orchestration

- Replaced the permanent multi-agent assembly line with adaptive specialist activation.
- Explicit cohesive modifying requests can be formed deterministically as one task without paying for a persistent strong planning call.
- Strong planning remains mandatory for read-only/investigation work, ambiguity, unresolved choices/tradeoffs, obvious decomposition, architecture-high work, sensitive boundaries outside deterministic confidence, and oversized requests.
- Added independent `architectureSignificance` classification and a conditional strong read-only software architect. Architecture significance is intentionally separate from failure-impact risk.
- Changed the normal adaptive `standard` path to **Worker A → independent strong reviewer → bounded same-Worker-A remediation → reviewer delta re-check**.
- Retained diversified Worker B peer convergence for `high_risk` work and explicit `routingMode=full`.
- Retained trivial low-risk text/docs handling and escalation semantics.
- Recovery coordinator creation is now genuinely on demand after a deterministic `BLOCKED` state instead of being justified by an always-present planner.
- Normal and resumable execution share the same planning/session-factory boundaries so resume cannot silently change specialist activation policy.

### Deterministic report, validation, and credential integrity

- Structured verdict normalization is case-insensitive; unknown verdicts fail closed rather than being silently coerced.
- Added conservative reconciliation for contradictory `BLOCKED` reports and for worker/reviewer reports whose own evidence says required/external validation is still unresolved.
- Added a Copilot pre-tool credential-provenance guard that denies model-synthesized operator-controlled tokens/secrets/passwords/credentials, including live SDK hooks where `toolArgs` arrive as a JSON string.
- Recovery authorizes credential **names** only; credential values are not persisted as provenance state.
- Session-factory construction is centralized so normal, resume, and recovery paths share the same credential guard instance.
- Successful required-validation evidence can be carried only for the **exact workspace revision** and matching validator identity.
- A later credential-less rerun of the same validator cannot invalidate already-successful exact-revision evidence; a changed revision or different validator still requires fresh validation.
- Validation language now distinguishes genuine missing-prerequisite blockers from successful negative-case coverage such as “token lookup fails clearly when missing” when the required external validator itself passed.

### Efficiency and measured architecture evidence

The architecture benchmark track separated topology from model policy and used deterministic external acceptance oracles. Across the measured scenarios:

- an unreviewed single implementer missed a real edge case, so independent strong review remains the normal modifying-task gate;
- strong review repeatedly found compatibility, stability, and regression-coverage defects worth fixing;
- Worker B produced unique semantic/security value on the Scenario08 path-containment boundary, supporting high-risk-only peer activation rather than permanent A/B convergence;
- persistent strong planning added substantial cost on cohesive tasks without demonstrating comparable unique value;
- report/credential/validation invariants were more reliable when moved into code/tool boundaries than when delegated to additional agents.

Representative live results:

- **Plannerless Scenario02 standard path** (`31833238956`): GPT-5.6 Luna Worker A → Terra strong reviewer; no planning Coordinator, Architect, or Worker B; **12 model calls, 6.198468 AI credits, 150,644 input tokens, 30.858s**. The prior equivalent product path with persistent planning used 14 calls, 10.805286 credits, 181,616 input tokens, and 52.179s—about **43% fewer credits and 41% lower elapsed time** in the measured plannerless run.
- **Scenario08 high-risk path** (`31831550343`): Terra Worker A ↔ GPT-5.4 mini Worker B → Terra reviewer; repository tests and independent path-containment oracle green.
- **Plannerless Scenario04 recovery path** (`31833891448`): no persistent planner; Worker A → on-demand Terra recovery coordinator → authorized retry → Worker B → Terra reviewer; deterministic recovery/workspace oracle green; **20 model calls, 17.048493 credits, 67.608s**.

### Packaging and validation

- All clean product slices passed Linux and Windows tests/checks and platform-specific VSIX packaging before consolidation.
- Release metadata is versioned consistently at `0.3.0`; tagged GitHub releases package and attach verified Linux x64 and Windows x64 VSIXes from the exact `main` release commit.
- Temporary benchmark/live-validation workflows are not part of the product candidate.

### Deferred

- A Convergent-owned deterministic `run_command` lifecycle with command/PID identity, streamed stdout/stderr, final exit status, timeout/cancel, and process-tree termination evidence remains issue #5 and is targeted after the adaptive-orchestration milestone.
- Persistent headless service / AG-UI / Open WebUI / CopilotKit frontends remain later multi-frontend work; the current headless implementation is a benchmark/regression harness.

## [0.2.0] - 2026-08-12

### Orchestration and correctness

- Added the original persistent strong coordinator and deterministic `read_only`, `trivial`, `standard`, and `high_risk` routing model.
- Added `/fast`, `/auto`, and `/thorough` execution flows.
- Added exact workspace fingerprints over HEAD plus staged, unstaged, and untracked state; A/B convergence required both workers to approve the same fingerprint.
- Added task-start workspace baselines protecting pre-existing dirty/staged/untracked user state.
- Added deterministic task-change manifests and coordinator inspection hints.
- Added structured worker/reviewer verdict reconciliation and semantic validation for `report_plan`.

### Recovery, resume, and control

- Added persistent workflow checkpoints and `/resume` at safe planning/task/review/blocker boundaries.
- Added structured `BLOCKED` handling through a fresh strong read-only recovery coordinator.
- Added **Convergent: Steer Active Agent**.
- Replaced wall-clock turn timeouts with event-driven tool-stall and agent-inactivity watchdogs.
- Added optional safe task-boundary checkpoint commits.
- Added operator-gated recovery for missing token/credential/secret/environment prerequisites.

### Review quality and efficiency

- Worker B received peer technical position, validation evidence, and deterministic task-change manifests.
- Strong review used revision-scoped validation evidence and remediation-delta review.
- Added workspace-confined `batch_view` for bounded multi-symbol search, tracked-file globbing, and multi-file reading.
- Fast planning minimized task count and stopped pathological headless over-decomposition before worker execution.

### Observability and headless harness

- Added rotating local trajectory audits with prompts/model/tool/token/cache/context/review/recovery/steering telemetry.
- Added deterministic offline efficiency analysis.
- Added the Node headless frontend using the real recovery/resume orchestration core.
- Added models-only preflight, fail-closed explicit-model eligibility checks, hard model/chat-request fuses, and scenario-specific acceptance oracles.

### 0.2 release evidence

- Scenario03 dependency ordering: exact A/B convergence + Terra review + deterministic oracle, 19 model calls.
- Scenario04 blocked external validation: genuine BLOCKED → Terra recovery coordinator → operator guidance → retry → A/B convergence → Terra review.
- Scenario05 pre-existing workspace state: dirty/untracked/ignored user state preserved byte-for-byte while implementation completed.
- Windows x64 and Linux x64 locked-install packaging and VSIX payload verification passed.

### Packaging and reproducibility

- Added committed npm lockfile and `npm ci` CI/headless installs.
- Added host-derived platform-specific VSIX packaging with glibc/musl distinction and native Copilot runtime verification.
- Synchronized package metadata to release version `0.2.0`.

## [0.1.0]

- Initial usable VS Code/GitHub Copilot SDK multi-agent orchestrator.
- Coordinator → Worker A → Worker B → strong reviewer workflow.
- Basic model selection, structured report tools, workspace permission handling, usage display, and VSIX packaging.
