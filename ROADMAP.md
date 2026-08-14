# Convergent roadmap

Convergent uses minor versions for architectural milestones. The goal is to ship each milestone once its measured release gates are satisfied rather than indefinitely extending one development line.

## 0.1.0 — working MVP

Initial usable VS Code/GitHub Copilot SDK multi-agent orchestrator.

## 0.2.0 — robust usable VS Code orchestrator

Released 2026-08-12.

0.2 established the first production-shaped workflow and the safety/observability foundation used by later optimization work:

```text
persistent strong coordinator
  -> Worker A / Worker B exact-fingerprint convergence
  -> persistent strong reviewer
  -> blocker recovery / resume / steering
```

Key 0.2 capabilities include deterministic routing, task-change manifests, dirty-worktree protection, `/fast` `/auto` `/thorough`, strong blocker recovery, revision-scoped validation evidence, trajectory audits, a headless benchmark/regression harness, hard inference fuses, and reproducible Windows/Linux VSIX packaging.

The architecture benchmark work after release intentionally treated that pipeline as the reference rather than assuming every permanent role was still cost-effective.

## 0.3.0 — adaptive orchestration

Current integration candidate: PR #16.

Primary theme: **activate expensive specialists only when their measured value or deterministic risk requires them, while moving correctness invariants into application/tool boundaries.**

Target architecture:

```text
ONE EXPLICIT COHESIVE MODIFYING REQUEST
  deterministic plan
        ↓
  standard: Luna Worker A -> Terra strong reviewer
                    ↕ same-A remediation

HIGH-RISK / FULL
  Worker A <-> diversified Worker B
        ↓
  Terra strong reviewer

ARCHITECTURE-HIGH
  strong read-only software architect
        ↓
  normal route-specific implementation/review path

REAL DETERMINISTIC BLOCKED
  on-demand strong recovery coordinator
```

### Candidate contents

- deterministic single-task formation for explicit cohesive modifying requests;
- conditional strong planning coordinator for ambiguity, read-only investigation, decomposition, choices/tradeoffs, architecture-high work, sensitive boundaries outside deterministic confidence, and oversized requests;
- `architectureSignificance` independent from failure-impact risk;
- conditional strong read-only software architect;
- normal `standard` path without permanent Worker B;
- high-risk/full peer convergence retained;
- same-Worker-A remediation after normal strong-review findings;
- shared session-factory construction across base/resume/recovery execution;
- case-insensitive structured verdict normalization and fail-closed unknown verdicts;
- deterministic contradictory-BLOCKED and required-validation reconciliation;
- operator-controlled credential provenance guard at the Copilot pre-tool boundary;
- exact-revision + validator-identity successful validation carry;
- disambiguation between real missing-prerequisite blockers and successful negative-case coverage.

### Measured evidence

The architecture benchmark matrix covered small parsing work, multi-file feature work, stable ordering, blocked external validation/recovery, dirty workspace safety, a larger cohesive feature, a one-shot iterable bug, and a high-risk path-containment boundary.

The measured conclusion is route-dependent rather than “more agents is always safer”:

- **strong review remains valuable** and is retained for modifying work;
- **persistent planning is not justified for every cohesive task**;
- **Worker B is not justified for every standard task**, but did provide unique semantic/security value on the high-risk containment scenario;
- deterministic credential/report/validation invariants are more reliable in code than as additional agent instructions.

Representative live candidate validation:

- plannerless Scenario02: Luna Worker A -> Terra reviewer, no Coordinator/Architect/B; 12 calls / 6.198468 credits / 30.858s versus 14 calls / 10.805286 credits / 52.179s with persistent planning;
- Scenario08 high-risk: Terra Worker A <-> GPT-5.4 mini Worker B -> Terra reviewer; repository tests + containment oracle green;
- plannerless Scenario04: no persistent planner; genuine BLOCKED -> on-demand Terra recovery coordinator -> authorized retry -> B convergence -> Terra review; deterministic recovery oracle green.

### 0.3 release gates

Before release:

- consolidated Linux and Windows tests/checks/package verification on exact candidate head;
- README/CHANGELOG/ROADMAP/configuration descriptions aligned with the adaptive architecture;
- one focused live architecture-high smoke on the consolidated product tree;
- stacked implementation PRs/issues marked as superseded/completed by the consolidated candidate;
- package version/lockfile changed to `0.3.0` only after an explicit release decision;
- no tag, merge, Marketplace publication, or GitHub Release without explicit authorization.

## 0.4.0 — controlled command execution/runtime

Primary theme: Convergent owns a stable command-execution lifecycle well enough to recover safely from command-level stalls.

Planned work:

- complete issue #5;
- stable Convergent-owned `run_command` contract;
- command/process identity;
- streamed stdout/stderr progress and bounded capture;
- exact final exit state/code;
- PID/process-tree termination evidence, especially Windows descendants;
- command-level timeout/cancellation;
- native command confirmation/progress reporting;
- safe recovery after stalled command/tool execution;
- evaluate Copilot SDK RPC shell primitives as backend pieces where they provide enough evidence;
- use a Convergent-owned child-process backend where the SDK/runtime cannot prove the required lifecycle.

The current Copilot SDK/CLI shell primitives may be useful implementation details, but they do not by themselves define the public Convergent command contract.

## 0.5.0 — headless / multi-frontend

The current headless runner is deliberately a benchmark/regression harness, not yet the remote product service.

Potential scope:

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
