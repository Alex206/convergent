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

### Current dev.14 state

The implementation is now beyond the original dev.11 convergence-efficiency slice:

- deterministic task-change manifests hand exact task-local changed paths to Worker B and the strong reviewer;
- bounded coordinator inspection hints and current-repository facts reduce Worker A rediscovery;
- `batch_view` performs bounded multi-symbol search, tracked-file globbing, and multi-file reading in one workspace-confined tool action;
- task-start dirty/staged/untracked user state is protected;
- `/fast`, `/auto`, and `/thorough` provide proportionate execution profiles without weakening strong-role safety;
- Fast plans at acceptance boundaries, normally keeps cohesive features in one modifying task, and headless Fast refuses over-decomposed plans before workers start;
- real resumable/recovery execution carries the same task-change context as the base engine;
- blocker recovery uses a fresh strong read-only recovery coordinator;
- `report_plan` is semantically validated by Convergent before it becomes authoritative, so malformed SDK/custom-tool payloads fail closed with a retry rather than entering task execution;
- trajectory audits capture prompts, model calls, tokens/cache/context, tools, passes, reviews, recovery, steering, and compaction;
- the headless benchmark harness uses the real orchestration core and emits deterministic offline efficiency summaries;
- Scenario 03 has an independent deterministic acceptance oracle in addition to target-repository tests;
- headless benchmarks fail closed when configured strong/adaptive roles would silently degrade to Copilot `auto`;
- headless Fast has phase-aware hard fuses for total model calls, calls per Convergent prompt, and observed Copilot chat-request quota growth, plus independent outer workflow timeouts;
- npm dependencies are locked and CI/manual benchmarks use `npm ci`, pinning the transitive Copilot CLI/runtime for reproducible trajectories;
- VSIX packaging is host/platform-targeted so native Copilot runtime dependencies cannot be mislabeled as a generic cross-platform package; Windows x64 and Linux x64 are verified end to end in CI.

Accepted `report_plan`, `report_pass`, `report_review`, and `report_recovery` calls remain authoritative Convergent data. The current Copilot SDK/CLI agent loop may continue after a successful custom-tool result, so Convergent does not generally abort healthy persistent sessions merely to make report tools appear terminal. Headless quota enforcement has one measured exception: when an accepted structured report is selected by the exact limit-th call of a per-turn hard cap, Convergent preserves that report and cancels only that session's unnecessary post-report continuation. This avoids both losing already-paid useful work and permitting an over-budget next model continuation.

### Benchmark evidence

The first genuine autonomous headless Scenario 03 run (`#403`) was deliberately cancelled because `/fast` became pathological: 10 Convergent prompts expanded into 108 underlying model calls and consumed a material portion of the benchmark account quota before completion.

That trajectory directly produced the current safeguards:

- compact acceptance-boundary planning;
- a maximum-three-task Fast headless plan gate;
- per-turn and whole-run underlying model-call fuses;
- a hard observed Copilot chat-request quota-delta fuse;
- deterministic offline prompt/model-call amplification analysis;
- fail-closed role-model eligibility checks;
- deterministic task-change handoffs across the live recovery/resume path;
- `batch_view` to collapse serial repository discovery/read continuations;
- tighter Fast worker guidance against redundant validation/runtime-state exploration.

A later models-only preflight (`#442`) called `listModels()` without creating an agent session or sending a prompt and showed that the current benchmark identity exposes only Copilot `auto`. That identity is therefore not eligible for the normal deterministic Convergent benchmark, which requires the configured strong/adaptive role policy to resolve explicitly.

Because of that eligibility limitation, subsequent `auto` runs were deliberately scoped as **non-authoritative diagnostics**, with smaller call/request/credit caps and hard GitHub Actions step timeouts. They are useful for measuring orchestration mechanics but do not satisfy the 0.2 strong-role release gate.

The latest bounded Worker-A-only diagnostic (`#587`) is the current efficiency checkpoint:

- 2 Convergent prompts total: Coordinator + Worker A;
- **9 underlying model calls total**: Coordinator 4, Worker A 5;
- 4 observed Copilot chat-request delta;
- about 3.33 reported AI credits;
- Worker A used the batch inspection path and issued its four main file writes in one model turn;
- Worker A reported `changed`;
- no Worker B or strong-review prompt was sent;
- the diagnostic-stop invariant passed;
- target repository tests passed;
- the independent Scenario 03 oracle passed 11/12 checks, with the sole auto-Worker-A miss being explicit `depends_on=None` accepted as an empty tuple rather than rejected as an invalid supplied non-sequence.

The run also exercised the phase-aware cap behavior live: an accepted structured result at the hard boundary was retained before the cap stopped further continuation. Synthetic tests replay the historical `#584` shape where a valid `report_plan` was selected on the ninth billed coordinator call.

### Release gates

Before 0.2.0 final:

- medium/dependency-ordering benchmark completes under the intended explicit model policy and bounded efficiency budget;
- blocker/recovery benchmark passes;
- one realistic nontrivial benchmark passes;
- correctness/safety issues discovered by those trajectories are fixed;
- no known critical orchestration regression remains;
- Windows x64 and Linux x64 packaging remains green from clean locked installs;
- package/release documentation is ready.

The current only-`auto` benchmark identity blocks the first three live-model gates; it is not a reason to weaken the strong coordinator/reviewer model policy. Resume authoritative benchmarking when the credential/provider path exposes explicit models that satisfy the configured role policy.

Do not extend `dev.N` merely for cosmetic tuning. Remaining work should either close a release gate or be deferred to the milestone where it belongs.

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
