# Changelog

All notable Convergent changes are documented here. The 0.2.0 section is still unreleased while PR #4 remains draft and its live benchmark gates are incomplete.

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

### Recovery, resume, and control

- Added persistent workflow checkpoints and `/resume` at safe planning/task/review/blocker boundaries.
- Added structured worker/reviewer `BLOCKED` handling through a fresh strong read-only recovery coordinator.
- Added immediate **Convergent: Steer Active Agent** control.
- Replaced total wall-clock turn timeouts with event-driven tool-stall and agent-inactivity watchdogs plus bounded abort/disconnect.
- Added optional safe task-boundary checkpoint commits that never sweep a pre-existing dirty worktree into an automatic commit.

### Review quality and efficiency

- Worker B receives the peer technical position, validation evidence, and deterministic task-change manifest and is required in Fast mode to inspect the actual changed implementation rather than relying only on search/test repetition.
- Strong review uses revision-scoped validation evidence and remediation-delta review instead of mechanically rerunning the same checks.
- Fast planning now minimizes task count and keeps cohesive implementation plus its acceptance tests together.
- Headless Fast stops a plan with more than three tasks before Worker A starts, preventing pathological task multiplication from consuming worker/reviewer quota.
- Tightened Fast worker guidance against redundant file reads, alternate-test-runner probing, and inspection of Copilot/Convergent runtime state for reassurance.

### Observability

- Added rotating local trajectory audits with manifests, JSONL events, summaries, and analysis output.
- Audit events include prompts, model/reasoning configuration, model-call/token/cache/context usage, tool activity, A/B passes, strong-review cycles, blocker recovery, steering, and compaction.
- Added a deterministic offline efficiency analyzer for prompt-to-underlying-model-call amplification, calls/tools per prompt, runtime/session model distribution, Copilot chat-quota delta, task progress, and serialized report recovery.

### Headless benchmark harness

- Added a Node headless frontend that uses the real recovery/resume orchestration core while keeping benchmark audit/output outside the target repository.
- Added separate least-privilege credentials for Copilot execution and private benchmark-repository checkout.
- Added models-only `listModels()` preflight that creates no agent session and sends no prompt.
- Headless benchmarks fail closed before inference when configured non-auto strong/adaptive roles would silently degrade to Copilot `auto`.
- Added hard Fast safeguards for total underlying model calls, underlying model calls per Convergent prompt, and observed Copilot chat-request quota growth, plus a soft AI-credit boundary and outer workflow timeout.
- Cancelled the first genuine headless Scenario 03 run after it exposed a pathological 10 Convergent prompts → 108 underlying model-call trajectory; the resulting findings drove the current planning/model/budget safeguards.

### Packaging and reproducibility

- Added a committed npm lockfile and changed CI/headless workflows to `npm ci` so transitive dependencies—including the bundled Copilot CLI/runtime selected by Copilot SDK 1.0.8—remain reproducible between benchmarks/builds.
- Added host-derived platform-specific VSIX packaging so a package cannot be labeled as a generic fallback while containing only one platform's native Copilot runtime.
- Added glibc/musl distinction for `linux-*` versus `alpine-*` VS Code targets.
- CI verifies Linux x64 and Windows x64 dependency installs, VSIX target metadata, and the platform-specific Copilot runtime contained inside the produced archive.
- Added platform-packaging regression tests and excluded packaging-only helpers/lock metadata from the VSIX runtime payload.

### Deferred

- A fully stable Convergent-owned `run_command` contract with streamed stdout/stderr, final exit state/code, process-tree termination evidence, and safe stalled-command recovery remains targeted for 0.3.0 (issue #5).
- Current Copilot SDK `session.rpc.shell.exec` / `shell.kill` primitives may be reused as backend pieces in 0.3 but do not replace the full required command lifecycle contract.
- VS Code-selected coordinator-model convenience remains a later optional feature (issue #2).
- Persistent headless service / AG-UI / Open WebUI / CopilotKit frontends remain later multi-frontend work; the current headless implementation is a benchmark/regression harness.

## [0.1.0]

- Initial usable VS Code/GitHub Copilot SDK multi-agent orchestrator.
- Coordinator → Worker A → Worker B → strong reviewer workflow.
- Basic model selection, structured report tools, workspace permission handling, usage display, and VSIX packaging.
