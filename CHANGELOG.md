# Changelog

All notable Convergent changes are documented here. The 0.2.0 implementation and release-validation gates are complete on PR #4; the release remains unpublished until the PR is explicitly approved/merged and a release is explicitly authorized.

## [0.2.0] - Unreleased

### Orchestration and correctness

- Added a persistent strong coordinator that owns requirements clarification, acceptance-boundary planning, route/risk classification, and bounded repository inspection for the whole request.
- Added deterministic `read_only`, `trivial`, `standard`, and `high_risk` routing with engine-enforced minimum safety levels.
- Added `/fast`, `/auto`, and `/thorough` execution flows without allowing Fast to bypass strong coordinator/reviewer safety.
- Added exact workspace fingerprints over HEAD plus staged, unstaged, and untracked state; A/B convergence requires both workers to approve the same fingerprint.
- Added task-start workspace baselines that protect pre-existing dirty/staged/untracked user state.
- Added deterministic task-change manifests and coordinator inspection hints so Worker B and the strong reviewer can begin from exact task-local changed paths.
- Corrected resumable/recovery execution so the live `RecoveryConvergentEngine` path receives the same deterministic task-change context as the base engine.
- Added structured worker/reviewer verdict reconciliation so unexplained workspace writes fail closed and valid writes cannot be mislabeled CLEAN.
- Added Convergent-side semantic validation for `report_plan`; malformed SDK/custom-tool payloads are rejected with a structured retry instead of entering orchestration state and crashing later task execution.

### Recovery, resume, and control

- Added persistent workflow checkpoints and `/resume` at safe planning/task/review/blocker boundaries.
- Added structured worker/reviewer `BLOCKED` handling through a fresh strong read-only recovery coordinator.
- Added immediate **Convergent: Steer Active Agent** control.
- Replaced total wall-clock turn timeouts with event-driven tool-stall and agent-inactivity watchdogs plus bounded abort/disconnect.
- Added optional safe task-boundary checkpoint commits that never sweep a pre-existing dirty worktree into an automatic commit.
- Reconcile a worker's contradictory CLEAN/CHANGED report to `BLOCKED` when its own structured summary/check evidence says required validation is still blocked or unavailable.
- Detect missing operator-controlled validation prerequisites such as tokens, credentials, secrets, and named `*_TOKEN`/`*_SECRET`/`*_CREDENTIAL` environment variables.
- Prevent retry/peer recovery from simply repeating a blocked required validation when an operator-controlled prerequisite is still missing; operator guidance must be obtained first and is injected into the selected recovery turn.

### Review quality and efficiency

- Worker B receives the peer technical position, validation evidence, and deterministic task-change manifest and is required in Fast mode to inspect the actual changed implementation rather than relying only on search/test repetition.
- Strong review uses revision-scoped validation evidence and remediation-delta review instead of mechanically rerunning the same checks.
- Fast planning minimizes task count and keeps cohesive implementation plus its acceptance tests together.
- Headless Fast stops a plan with more than three tasks before Worker A starts, preventing pathological task multiplication from consuming worker/reviewer quota.
- Tightened Fast worker guidance against redundant file reads, alternate-test-runner probing, and inspection of Copilot/Convergent runtime state for reassurance.
- Added a workspace-confined `batch_view` inspection tool that can search several literal symbols, match tracked-file globs, and read resulting text files in one model-selected tool action. It bounds output, rejects `.git`/outside/symlink escapes and binary files, and canonicalizes absolute paths only when they remain inside the workspace.
- Live explicit-model release validation reduced the historical Scenario 03 trajectory from an unfinished 108-call runaway to a complete A/B + strong-review workflow in 19 model calls.

### Observability

- Added rotating local trajectory audits with manifests, JSONL events, summaries, and analysis output.
- Audit events include prompts, model/reasoning configuration, model-call/token/cache/context usage, tool activity, A/B passes, strong-review cycles, blocker recovery, steering, and compaction.
- Added a deterministic offline efficiency analyzer for prompt-to-underlying-model-call amplification, calls/tools per prompt, runtime/session model distribution, Copilot chat-quota delta, task progress, and serialized report recovery.
- Benchmark evidence records exact Convergent, Copilot SDK, transitive Copilot CLI/runtime, Node, and host-runtime provenance.

### Headless benchmark harness

- Added a Node headless frontend that uses the real recovery/resume orchestration core while keeping benchmark audit/output outside the target repository.
- Added separate least-privilege credentials for Copilot execution and private benchmark-repository checkout.
- Added models-only `listModels()` preflight that creates no agent session and sends no prompt.
- Headless benchmarks fail closed before inference when configured non-auto strong/adaptive roles would silently degrade to Copilot `auto`.
- Added hard Fast safeguards for total underlying model calls, underlying model calls per Convergent prompt, and observed Copilot chat-request quota growth, plus a soft AI-credit boundary and independent outer workflow timeout.
- Made hard model/request fuses phase-aware: an already-billed limit-th call may finish its selected tool action; accepted structured reports at a per-turn cap are preserved while only the session's post-report SDK continuation is cancelled; non-terminal cap hits stop before another model continuation; extra observed calls still fail closed immediately.
- Added deterministic scenario-specific acceptance oracles for dependency ordering, blocked external validation/recovery, and pre-existing workspace-state safety.
- Added non-authoritative bounded `auto` diagnostics for plan-only and Worker-A-only live-path measurement when a credential is ineligible for the configured strong/adaptive model policy.

### 0.2 release-validation evidence

The initial Copilot Free/`auto` Scenario 03 run (#403) was cancelled after about 8.8 minutes and 108 underlying model calls without completing. Those findings drove the planning, handoff, inspection, model-policy, and quota changes above.

The final release-validation identity used Copilot Pro with 19 selectable models. The configured policy resolved explicitly to GPT-5.6 Terra for the coordinator and strong reviewer, adaptive Worker A, and GPT-5.4 mini for Worker B in the measured standard Fast tasks.

- **Scenario 03 / CI #595 — dependency ordering:** complete standard task, exact A/B convergence, Terra strong review, deterministic oracle 12/12; **19 model calls**, about **69 s**, about **20.46 internal AI credits**.
- **Scenario 04 / CI #610 — blocked external validation:** genuine BLOCKED worker path, Terra recovery coordinator, captured operator guidance, token-scoped retry, A/B convergence, Terra strong review, workspace + recovery oracle fully green; **25 model calls**, about **74 s**, about **19.90 internal AI credits**.
- **Scenario 05 / CI #615 — pre-existing workspace state:** complete implementation with untracked `.vscode/settings.json` and ignored `notes.local` preserved byte-for-byte, exact A/B convergence, Terra strong review, deterministic oracle fully green; **17 model calls**, about **42 s**, about **13.39 internal AI credits**.

All healthy individual agent turns stayed within the 10-call per-turn hard fuse. The measured Pro release runs also show that the older Free-era 12-credit soft boundary is too small for normal explicit-model A/B + strong-review work; benchmark operators should raise the whole-run/soft envelope deliberately while keeping the per-turn fuse and outer timeout bounded.

### Packaging and reproducibility

- Added a committed npm lockfile and changed CI/headless workflows to `npm ci` so transitive dependencies—including the bundled Copilot CLI/runtime selected by Copilot SDK 1.0.8—remain reproducible between benchmarks/builds.
- Added host-derived platform-specific VSIX packaging so a package cannot be labeled as a generic fallback while containing only one platform's native Copilot runtime.
- Added glibc/musl distinction for `linux-*` versus `alpine-*` VS Code targets.
- CI verifies Linux x64 and Windows x64 dependency installs, VSIX target metadata, and the platform-specific Copilot runtime contained inside the produced archive.
- Added platform-packaging regression tests and excluded packaging-only helpers/lock metadata from the VSIX runtime payload.
- Synchronized `package.json` and the committed lockfile to the 0.2.0 release version without creating a tag or publishing a package.

### Deferred

- A fully stable Convergent-owned `run_command` contract with streamed stdout/stderr, final exit state/code, process-tree termination evidence, and safe stalled-command recovery remains targeted for 0.3.0 (issue #5).
- Current Copilot SDK `session.rpc.shell.exec` / `shell.kill` primitives may be reused as backend pieces in 0.3 but do not replace the full required command lifecycle contract.
- VS Code-selected coordinator-model convenience remains a later optional feature (issue #2).
- Persistent headless service / AG-UI / Open WebUI / CopilotKit frontends remain later multi-frontend work; the current headless implementation is a benchmark/regression harness.

## [0.1.0]

- Initial usable VS Code/GitHub Copilot SDK multi-agent orchestrator.
- Coordinator → Worker A → Worker B → strong reviewer workflow.
- Basic model selection, structured report tools, workspace permission handling, usage display, and VSIX packaging.
