# Convergent roadmap

Convergent uses minor versions for architectural milestones and `dev.N` versions for measured iteration within a milestone. The goal is to ship each milestone once its release gates are satisfied rather than extending a development series indefinitely.

## 0.1.0 — working MVP

Initial usable VS Code/GitHub Copilot SDK multi-agent orchestrator.

## 0.2.0 — robust usable VS Code orchestrator

The 0.2 line hardens convergence correctness, recovery, review quality, live steering, observability, resume behavior, packaging, and proportionate execution flows while preserving the core safety invariant:

```text
persistent strong coordinator
  -> Worker A / Worker B exact-fingerprint convergence
  -> persistent strong reviewer
  -> A/B remediation when needed
  -> same strong reviewer recheck
```

### Release-candidate state

The implementation and live release-validation gates are complete on PR #4. Package metadata is synchronized to `0.2.0`; no merge, tag, marketplace publication, or GitHub release is implied by this state.

The 0.2 implementation includes:

- deterministic task-change manifests that hand exact task-local changed paths to Worker B and the strong reviewer;
- bounded coordinator inspection hints and current-repository facts to reduce Worker A rediscovery;
- workspace-confined `batch_view` for bounded multi-symbol search, tracked-file globbing, and multi-file reading in one tool action;
- protection for task-start dirty/staged/untracked user state;
- `/fast`, `/auto`, and `/thorough` proportionate execution profiles without weakening strong-role safety;
- acceptance-boundary Fast planning that normally keeps cohesive implementation and acceptance tests in one modifying task;
- a maximum-three-task headless Fast planning gate before workers start;
- live recovery/resume execution carrying the same deterministic task-change context as the base engine;
- fresh strong read-only recovery coordinators for worker/reviewer blockers;
- Convergent-side semantic validation of `report_plan` before it becomes authoritative;
- reconciliation of contradictory CLEAN/CHANGED worker reports when their own structured evidence says required validation is still blocked;
- operator-gated recovery for missing token/credential/secret/environment prerequisites instead of unchanged retry loops;
- trajectory audits over prompts, model calls, tokens/cache/context, tools, passes, reviews, recovery, steering, and compaction;
- deterministic offline efficiency summaries and scenario-specific acceptance oracles;
- fail-closed headless model-policy preflight;
- phase-aware hard fuses for total model calls, calls per Convergent prompt, and observed Copilot chat-request growth, plus independent outer workflow timeouts;
- reproducible `npm ci` installs from a committed lockfile that pins the transitive Copilot CLI/runtime;
- host/platform-targeted VSIX packaging with Windows x64 and Linux x64 payload verification.

Accepted `report_plan`, `report_pass`, `report_review`, and `report_recovery` calls remain authoritative Convergent data. The current Copilot SDK/CLI agent loop may continue after a successful custom-tool result, so Convergent does not generally abort healthy persistent sessions merely to make report tools appear terminal. Headless quota enforcement has one measured exception: when an accepted structured report is selected by the exact limit-th call of a per-turn hard cap, Convergent preserves that report and cancels only that session's unnecessary post-report continuation. This avoids both losing already-paid useful work and permitting an over-budget next model continuation.

### Benchmark evidence

The first genuine autonomous headless Scenario 03 run (`#403`) under the earlier Copilot Free/`auto` identity was deliberately cancelled because `/fast` became pathological: 10 Convergent prompts expanded into 108 underlying model calls and consumed a material portion of the benchmark account quota before completion.

That trajectory directly produced:

- compact acceptance-boundary planning;
- a maximum-three-task Fast headless plan gate;
- per-turn and whole-run underlying model-call fuses;
- a hard observed Copilot chat-request quota-delta fuse;
- deterministic offline prompt/model-call amplification analysis;
- fail-closed role-model eligibility checks;
- deterministic task-change handoffs across the live recovery/resume path;
- `batch_view` to collapse serial repository discovery/read continuations;
- tighter Fast worker guidance against redundant validation/runtime-state exploration.

After the benchmark identity moved to Copilot Pro, the models-only preflight exposed 19 selectable models and the intended explicit role policy became eligible. The measured release-validation policy resolved GPT-5.6 Terra for the persistent coordinator and strong reviewer, adaptive Worker A, and GPT-5.4 mini for Worker B in the standard Fast scenarios.

Release evidence:

- **Scenario 03 / CI #595 — dependency ordering:** one standard task, exact A/B convergence, Terra strong review, deterministic dependency-ordering oracle 12/12; **19 model calls**, about **69 s**, about **20.46 internal AI credits**.
- **Scenario 04 / CI #610 — blocked external validation:** genuine BLOCKED path, Terra recovery coordinator, operator guidance, token-scoped retry, A/B convergence, Terra strong review, deterministic workspace/recovery oracle fully green; **25 model calls**, about **74 s**, about **19.90 internal AI credits**.
- **Scenario 05 / CI #615 — pre-existing workspace state:** normal implementation while untracked `.vscode/settings.json` and ignored `notes.local` remain byte-for-byte unchanged, exact A/B convergence, Terra strong review, deterministic oracle fully green; **17 model calls**, about **42 s**, about **13.39 internal AI credits**.

All healthy individual agent turns stayed below the 10-call per-turn hard fuse. The release runs also established that the earlier 12-credit soft benchmark boundary was too small for normal explicit-model strong-review work, so benchmark operators may raise only the whole-run/soft envelope while retaining the measured per-turn fuse and an independent workflow timeout.

### 0.2.0 release gates

The planned gates are satisfied on the release-candidate branch:

- dependency-ordering/nontrivial explicit-model benchmark: **passed (#595)**;
- blocker/recovery benchmark: **passed (#610)**;
- pre-existing workspace-state safety regression: **passed (#615)**;
- correctness/safety defects exposed by those trajectories: **fixed and regression-tested**;
- no known critical orchestration regression remains from the measured set;
- Windows x64 and Linux x64 clean locked-install packaging: **green**;
- package version synchronized to `0.2.0`;
- release/benchmark documentation prepared.

The remaining action is operational rather than development work: run the final clean exact-head CI after release-documentation changes, then merge/tag/publish only when explicitly authorized. Do not extend `dev.N` merely for cosmetic tuning.

## 0.3.0 — controlled execution/runtime

Primary theme: Convergent owns a stable command-execution contract well enough to recover safely from command-level stalls.

Planned work:

- stable Convergent-owned `run_command` tool contract;
- command/process identity, stdout/stderr progress, final exit state/code, and bounded capture;
- PID/process-tree termination evidence, especially Windows descendants;
- command-level timeout/cancellation;
- native command confirmation and progress reporting;
- safe coordinator recovery after stalled command/tool execution;
- complete issue #5;
- automatic steering where audit evidence supports it;
- measured context/session rotation only if trajectory data justifies it;
- reduce unnecessary LLM loops where the SDK/runtime provides a safe mechanism.

Current Copilot SDK/CLI exposes experimental `session.rpc.shell.exec` and `session.rpc.shell.kill` primitives. They are useful candidate backend pieces but do not currently expose enough public streamed output/final exit/status/process-tree semantics to replace the full `run_command` contract. 0.3 should adapt them where they can prove the needed behavior and use a Convergent-owned process backend where they cannot.

## 0.4.0 — headless / multi-frontend

The 0.2 headless benchmark runner is deliberately a regression harness, not yet the remote product service.

Potential 0.4 scope:

- persistent headless Convergent service;
- repository/worktree lifecycle management;
- stable API and typed event stream;
- AG-UI adapter;
- Open WebUI integration;
- CopilotKit or another dedicated web frontend;
- remote pause/resume/steering;
- GitHub issue/PR-driven remote runs.

VS Code remains the primary local coding frontend; remote/web integrations should consume frontend-neutral Convergent contracts rather than private Copilot UI internals.

## 1.0.0 — stable production contracts

Stable orchestration, recovery, execution, event/API, and packaging contracts suitable for production-quality use.
