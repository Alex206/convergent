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

### Current dev.11 focus

- deterministic task change manifests so Worker B and the strong reviewer receive exact repository-relative changed-path hints instead of rediscovering paths;
- bounded coordinator inspection hints handed to Worker A without copying coordinator transcript/context;
- stronger Fast Worker B guidance to inspect the actual changed implementation/diff rather than relying on symbol search plus repeated tests;
- continued trajectory measurement of structured `report_*` continuation overhead.

Accepted `report_plan`, `report_pass`, and `report_review` calls are authoritative Convergent data, but the Copilot SDK/CLI agent loop still feeds a successful custom-tool result back to the model and ends reliably at `session.idle`. Convergent therefore does not abort persistent sessions merely to make these tools appear terminal. Revisit this optimization if the SDK exposes a documented terminal-tool/stop-after-tool contract.

### Release gates

Before 0.2.0 final:

- medium benchmark passes;
- blocker/recovery benchmark passes;
- realistic nontrivial benchmark passes;
- correctness/safety issues discovered by those trajectories are fixed;
- no known critical orchestration regression remains;
- package and release documentation are ready.

If dev.10/dev.11 survive the benchmark set reasonably, release 0.2.0 instead of extending `0.2.0-dev.N` indefinitely.

## 0.3.0 — controlled execution/runtime

Primary theme: Convergent owns command execution well enough to recover safely from command-level stalls.

Planned work:

- Convergent-owned `run_command`;
- PID/process-tree ownership;
- command-level cancellation;
- native command confirmation and progress reporting;
- safe coordinator recovery after stalled command/tool execution;
- complete issue #5;
- automatic steering where audit evidence supports it;
- measured context/session rotation only if trajectory data justifies it;
- reduce unnecessary LLM loops where the SDK/runtime provides a safe mechanism.

## 0.4.0 — headless / multi-frontend

Potential scope:

- headless Convergent service;
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
