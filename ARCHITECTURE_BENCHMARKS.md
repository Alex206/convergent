# Convergent architecture benchmarks

This document records the post-0.2 architecture evaluation from issue #6. The evaluation remains headless/experimental: released VS Code orchestration on `main` is unchanged while topology, model policy, correctness, cost, latency, recovery, and safety are measured before proposing a product architecture change.

Scenarios 01–05 use the pinned baseline `Alex206/convergent-test-repo@1f38b2606f306ef4902d6159e8c9b7f3d8fe9aef`. Stage-two scenarios use separately recorded exact fixture SHAs. Machine-readable evidence lives under `benchmarks/architecture-results/`.

## Current conclusion

The data no longer supports one fixed topology for every modifying task. The leading product hypothesis is **adaptive specialist activation**:

```text
ordinary low/medium-risk modifying task

 deterministic route/risk + objective invariants
                     │
                     ▼
         GPT-5.6 Luna implementer
                     │
                     ▼
         GPT-5.6 Terra reviewer
                     │
           clean ────┴──── findings
             │                 │
             ▼                 ▼
            done       same-Luna remediation
                               │
                               └──► Terra delta review

high-risk security / boundary task

         GPT-5.6 Luna Worker A
                     ↕
       diversified Worker B
       currently GPT-5.4 mini
                     │
                     ▼
         GPT-5.6 Terra reviewer

genuine deterministic BLOCKED
                     │
                     ▼
        on-demand Terra recovery coordinator

ambiguity / decomposition / architecture choice
                     │
                     ▼
        on-demand strong planning coordinator
```

The evidence supports four distinct conclusions:

1. **Independent strong review earns its cost.** It has caught or prevented real semantic misses.
2. **The persistent planning coordinator does not earn default-path cost on cohesive measured tasks.** Make it conditional.
3. **Worker B does not earn default-path cost on ordinary work, but Scenario 08 provides direct evidence that it can add unique value on a high-risk security boundary.** Make it risk-triggered.
4. **Objective protocol/safety conditions belong in deterministic Convergent code, not in extra agent prompts.**

This is still a benchmark conclusion rather than a product merge decision. The next work should productize and validate the adaptive policy rather than continue broad topology sweeps.

## Deterministic defects discovered by the benchmark

Some apparent value from extra agents was actually compensation for deterministic orchestration defects:

- **Synthetic credential bypass:** Scenario 04 showed an agent inventing an inline `TASKFLOW_RELEASE_TOKEN` instead of reporting a real operator-controlled prerequisite.
- **Hook argument serialization:** Copilot can deliver hook `toolArgs` as JSON text, so credential inspection must normalize serialized and object forms.
- **Structured verdict casing:** live reports can emit uppercase `CHANGED` / `CLEAN`; the experimental session boundary normalizes verdict casing before the released parser.
- **Contradictory BLOCKED evidence:** deterministic report integrity now prevents unsupported BLOCKED transitions when the structured evidence itself says the task is complete and validation succeeded.
- **Blocked required validation accepted as success:** one released-v0.2 Scenario 04 trajectory completed without the intended operator-recovery path despite required external validation remaining blocked.

Issue #8 tracks productizing these integrity fixes. The architecture lesson is that deterministic invariants should own credential provenance, report validity, workspace safety, required-validation state, and eventually process lifecycle; agents should be paid for semantic uncertainty.

## Topologies evaluated

### A0 — single agent

One implementation agent owns inspection, implementation, validation, and self-review. It is the minimum-cost baseline. Observed correctness misses make it unsuitable as the general modifying-task default.

### A1 — implementer + strong reviewer

```text
implementer → strong reviewer ↔ bounded same-implementer remediation
```

No persistent planning coordinator and no Worker B. Recovery activates only after genuine BLOCKED evidence. The production-cost variant uses GPT-5.6 Luna for implementation and GPT-5.6 Terra for independent review.

### A2 — peer convergence

```text
Worker A ↔ Worker B exact-fingerprint convergence → optional strong reviewer
```

Peer topologies were not cost-competitive as the ordinary default. Scenario 08 nevertheless demonstrated unique peer value on a high-risk security task.

### A3 — released Convergent 0.2

```text
persistent Terra coordinator
          ↓
adaptive Worker A ↔ diversified Worker B convergence
          ↓
Terra strong reviewer
```

This remains the stable released reference and is deliberately unchanged by experimental benchmark fixes.

## Scenario evidence

### Scenario 01 — small duration parser

| Architecture | Oracle | Calls | Credits | Input | Time |
|---|---:|---:|---:|---:|---:|
| single adaptive Luna | **fail** | 5 | **0.572** | 65,563 | 12.1 s |
| Luna → Terra reviewer | **pass** | 11 | **4.450** | 123,814 | 24.0 s |
| released v0.2 reference | **pass** | 22 | 13.212 | 256,369 | 49.6 s |

The single agent accepted malformed `1 s`; its own tests missed the defect. This is the clearest reason not to turn “cheap” into “unreviewed” for normal modifying work.

### Scenario 02 — realistic retry-backoff feature

Two post-normalization repetitions:

| Architecture | Passes | Avg calls | Avg credits | Avg input | Avg time |
|---|---:|---:|---:|---:|---:|
| **Luna → Terra reviewer** | **2/2** | **12.0** | **6.875** | **178,281** | **35.1 s** |
| Terra → Terra reviewer | **2/2** | 14.5 | 16.170 | 221,866 | 46.0 s |
| released v0.2 | **2/2** | 17.5 | 20.033 | 222,998 | 55.3 s |

Luna→Terra versus v0.2: about **31% fewer calls, 65.7% fewer credits, 20% fewer input tokens, and 36% less wall time** at the same observed correctness. A strong reviewer also found real backwards-compatibility defects in one Terra/Terra repetition and drove successful remediation.

### Scenario 03 — dependency ordering / stable-order contract

Fresh economical reviewed repetitions: **2/2**, averaging 11 calls, 5.674 credits, 139,004 input tokens and 41.8 s. Historical v0.2: **2/2**, averaging 20 calls, 24.071 credits, 273,723 input and 123.7 s.

That is roughly **76% fewer credits, 45% fewer calls, 49% fewer input tokens, and 66% less wall time**. Historical unreviewed single-agent runs missed the stable-order edge.

### Scenario 04 — blocked external validation and recovery

Scenario 04 intentionally withholds `TASKFLOW_RELEASE_TOKEN`. Policy-correct economical runs demonstrate:

```text
BLOCKED → Terra recovery → operator context → retry → Terra review → complete
```

Two policy-correct economical repetitions average **16.5 calls, 7.525 credits, 196,386 input and 40.4 s**. Historical passing v0.2 recovery repetitions average **27.5 calls, 21.052 credits, 296,758 input and 86.4 s**.

That is approximately **40% fewer calls, 64.3% fewer credits, 33.8% fewer input tokens and 53.2% less wall time**. The scenario also discovered the synthetic-credential and required-validation integrity defects, which are deterministic policy problems rather than reasons for an always-on coordinator.

### Scenario 05 — preserve pre-existing workspace state

Both topologies pass the full 9-check safety oracle. Luna→Terra uses 11 calls, 4.497 credits, 123,615 input and 21.4 s: about **64% fewer credits, 48% fewer calls, 45% fewer input and 53% less wall time** than the matched v0.2 run.

### Scenario 06 — larger cohesive task-environment feature

Both architectures pass the external contract and repository tests:

| Architecture | Calls | Credits | Input | Time |
|---|---:|---:|---:|---:|
| Luna → Terra reviewer | 21 | **9.531** | 318,997 | **69.5 s** |
| released v0.2 | **20** | 20.831 | **275,372** | 83.8 s |

This is an important non-dominated-dimensions case. The lean route used slightly **more calls and input tokens** because Terra review found a real omission: the requested focused regression tests were missing. The same Luna implementer added them and the second review passed. Despite that remediation, the route used about **54% fewer credits** and **17% less wall time**.

This strengthens, rather than weakens, the argument for independent review: the reviewer bought correctness, while the cheaper implementation tier still kept total credit cost low.

### Scenario 07 — one-shot required-label iterable bug

Both pass the six-check oracle:

| Architecture | Calls | Credits | Input | Time |
|---|---:|---:|---:|---:|
| Luna → Terra reviewer | **10** | **4.577** | **112,697** | **27.3 s** |
| released v0.2 | 18 | 15.552 | 193,617 | 47.2 s |

The economical route used about **44% fewer calls, 70.6% fewer credits, 41.8% fewer input tokens and 42.1% less wall time**.

### Scenario 08 — high-risk artifact-path containment

This fixture deliberately seeds a security boundary bug involving sibling-prefix traversal, absolute paths, root-self paths, normalization, and symlink escapes.

| Architecture | Oracle | Calls | Credits | Input | Time |
|---|---:|---:|---:|---:|---:|
| **Luna → Terra reviewer** | **6/6** | **11** | **6.133** | **143,682** | **36.5 s** |
| Luna ↔ GPT-5.4 mini peer → Terra reviewer | **6/6** | 18 | 7.910 | 230,022 | 66.4 s |
| released v0.2 | **6/6** | 16 | 16.389 | 182,256 | 62.1 s |

The final oracle alone would make Luna→Terra look sufficient. The trajectory provides the more important evidence: in the peer repetition, Luna's first implementation contained a genuine strict-descendant defect. It assumed `Path.relative_to(root).parts` would be empty for an exact root match; Python represents that relative result as `.`. **GPT-5.4 mini Worker B independently identified and fixed the defect.** Worker A then accepted the correction, the workers converged, Terra review was clean, and the external oracle passed 6/6.

The peer route therefore bought demonstrable assurance, but not for free. Relative to the economical reviewed route it used about **64% more calls, 29% more credits, 60% more input tokens and 82% more wall time**. Relative to released v0.2 it still used about **52% fewer credits**, although it used more calls/input/time in this single repetition.

This is the first direct evidence that Worker B belongs on the **high-risk assurance frontier** even though it does not belong on the default ordinary-task path.

## Pareto interpretation

### Normal cohesive modifying tasks

Luna→Terra is the observed Pareto-leading product candidate. Across the measured low/medium-risk scenarios it matches deterministic correctness while dramatically reducing credit cost and usually reducing calls, tokens, and latency. Scenario 06 shows that remediation can make calls/input slightly worse in an individual task, but the route remains economically attractive because most implementation work is done by Luna and strong review is targeted.

### High-risk security / boundary tasks

There is now an **assurance/cost frontier**, not one universal winner:

- Luna→Terra is cheapest and passed Scenario 08;
- Luna↔diversified-peer→Terra costs more, but produced unique independent defect detection;
- released v0.2 pays for the same broad role set plus an always-on planning coordinator and was much more expensive in credits.

The sensible product policy is to pay the peer premium only when deterministic route/risk classification justifies it.

### Blocked tasks

On-demand Terra recovery is supported. Do not pay a recovery/planning coordinator until deterministic evidence establishes a real blocker.

### Single-agent modifying tasks

They remain useful as a lower-bound baseline and perhaps for deliberately narrow routes with strong deterministic acceptance, but observed misses make them unsuitable as the general default.

## Proposed routing policy to validate for 0.3+

| Route / condition | Proposed topology |
|---|---|
| read-only | preserve conservative current read-only behavior until separately optimized |
| trivial modifying | Luna → independent review unless a narrowly defined deterministic bypass is proven safe |
| standard low/medium risk | Luna → Terra review → bounded same-Luna remediation/delta review |
| high risk / security / boundary | Luna ↔ diversified Worker B convergence → Terra review |
| ambiguous / decomposable / architectural | on-demand strong planning coordinator, then select standard/high-risk execution route |
| genuine BLOCKED | on-demand Terra recovery coordinator, then deterministic retry/peer policy |
| reviewer disagreement / repeated remediation failure | escalate to peer and/or strong coordinator |

Candidate high-risk signals include security-sensitive containment or authorization boundaries, credential/secret handling, destructive data operations, release/build integrity, cross-component interface changes, and other routes already classified high-risk by deterministic policy.

## What the benchmark has answered

The broad topology question from #6 is substantially answered:

- do **not** replace v0.2 with an unreviewed single agent;
- do **not** keep the full v0.2 role set always active merely for safety;
- use the economical capable implementer + independent strong reviewer as the normal path;
- use deterministic invariants for objective safety/protocol conditions;
- activate recovery, planning, peer, and future specialists only when their triggering condition exists;
- retain peer convergence specifically as a high-risk escalation because Scenario 08 demonstrated unique semantic value.

The machine-readable synthesis is `benchmarks/architecture-results/pareto-synthesis-2026-08-14.json`; Scenario 08 is recorded in `benchmarks/architecture-results/scenario08-stage2-rep1.json`.

## Remaining evidence before productization

Do not resume broad equal-quota topology sweeps. The highest-value next steps are:

1. run only a small number of additional high-risk tasks/repetitions to estimate how often peer convergence provides unique value;
2. define deterministic escalation predicates for normal → peer, planning coordinator, and recovery;
3. productize issue #8's deterministic report/validation/credential integrity invariants in the normal execution boundary;
4. validate the resulting adaptive topology end-to-end before replacing released v0.2 orchestration;
5. keep truly parallel isolated-worker/worktree experiments separate because they test decomposition/concurrency, not this shared-workspace assurance topology.

## Product boundary

- released `main` / v0.2.0 remains unchanged;
- experimental integrity fixes remain under the headless benchmark surface;
- PR #7 remains draft;
- temporary inference workflows have been removed after evidence collection;
- ordinary PR CI uses zero Copilot inference.
