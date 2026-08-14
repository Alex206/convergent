# Convergent architecture benchmarks

This document records the post-0.2 architecture evaluation from issue #6. The work remains headless/experimental: released VS Code orchestration on `main` is unchanged while correctness, cost, and latency are measured before proposing a product architecture change.

All controlled scenarios below use the pinned target:

`Alex206/convergent-test-repo@1f38b2606f306ef4902d6159e8c9b7f3d8fe9aef`

## Current conclusion

The strongest candidate for the normal modifying-task path is now:

```text
deterministic route / risk / safety invariants
                    │
                    ▼
       economical capable implementer
              GPT-5.6 Luna
                    │
                    ▼
       independent strong reviewer
              GPT-5.6 Terra
                    │
          clean ────┴──── findings
            │                 │
            ▼                 ▼
           done       same implementer remediation
                              │
                              └──► reviewer delta re-check

 genuine deterministic BLOCKED
                    │
                    ▼
      on-demand strong recovery coordinator
```

The evidence does **not** support removing independent strong review. It increasingly supports removing the persistent coordinator and Worker B from the default cohesive-task path, while retaining them or other specialists as conditional escalation mechanisms for ambiguity, high risk, decomposition, disagreement, or repeated review failure.

This is not yet a product decision. The existing deterministic benchmark set is still small and repository-local; larger realistic feature/bug tasks are required before changing released orchestration.

## Why the architecture changed during the experiment

The benchmark track found that some apparent value from additional agents was actually compensation for deterministic protocol/integrity defects:

1. **Synthetic credential bypass.** A cheap Scenario 04 arm invented an inline `TASKFLOW_RELEASE_TOKEN` and bypassed a real operator-controlled prerequisite. The experimental credential-integrity guard now denies synthetic secret/token/password assignments unless inherited from the host or explicitly authorized through operator recovery context.
2. **Structured verdict casing.** Some Luna `report_pass` calls used `"CHANGED"` / `"CLEAN"`. The released report normalizer accepts only lowercase values and therefore silently converted those reports to `blocked`. This produced unnecessary recovery and peer work. The experimental session boundary now lowercases structured verdicts before the released normalizer; the released v0.2 reference remains untouched.
3. **Contradictory BLOCKED evidence.** The experimental report-integrity guard conservatively prevents an unsupported `BLOCKED` from driving recovery when the same structured report explicitly says the implementation is complete/no issues remain, has successful validation evidence, has no findings, and contains no actual blocker/prerequisite evidence.
4. **Blocked required validation can still be accepted.** A live released-v0.2 Scenario 04 repetition returned CHANGED/CLEAN while its own evidence said the required external validator was blocked because the token was missing. That run completed without operator recovery. The benchmark therefore also exposed a released validation-blocker reconciliation gap.

The architectural lesson is important: **deterministic invariants should handle protocol validity and objective tool/workspace conditions; expensive agents should be reserved for semantic uncertainty.**

## Topologies evaluated

### A0 — single agent

One implementation agent owns inspection, implementation, tests, self-check, and final report. No independent reviewer.

This is the minimum-cost baseline, not the current default candidate.

### A1 — implementer + strong reviewer

```text
implementer → strong reviewer ↔ bounded same-implementer remediation
```

No persistent planning coordinator and no Worker B. Recovery can be attached independently and activated only after a real `BLOCKED` condition.

Variants measured:

- strong/strong: Terra implementer → Terra reviewer;
- economical reviewed: Luna implementer → Terra reviewer;
- adaptive: existing model policy decides the implementer model, Terra remains the strong reviewer.

### A2 — peer competition

- Terra A ↔ Terra B, no final reviewer;
- Terra A ↔ Terra B → Terra reviewer.

Initial Scenario 03 runs passed, but they have not shown a cost/correctness advantage over A1 and are no longer the highest-priority arm for cohesive standard work.

### A3 — released Convergent 0.2

```text
persistent Terra coordinator
          ↓
adaptive Worker A ↔ diversified Worker B exact-fingerprint convergence
          ↓
Terra strong reviewer
```

This remains the reference architecture and is deliberately unchanged by the experimental fixes.

## Cross-scenario evidence

### Scenario 01 — small duration parser

This scenario asks whether multi-agent overhead is justified on a small local change.

After removing structured-report recovery noise:

| Architecture | Oracle | Calls | AI credits | Input tokens | Elapsed |
|---|---:|---:|---:|---:|---:|
| adaptive single Luna | **fail** | 5 | **0.572** | 65,563 | 12.1 s |
| economical Luna → Terra review | **pass** | 11 | **4.450** | 123,814 | 24.0 s |
| released v0.2 reference* | **pass** | 22 | 13.212 | 256,369 | 49.6 s |

`*` The v0.2 reference is the earlier pinned repetition; it was not rerun after the experimental-only protocol fix.

The single agent was extraordinarily cheap but accepted malformed internal whitespace (`1 s`) that its own tests missed. Across the two observed adaptive/single Scenario 01 repetitions, single-agent correctness is only 1/2. This is the clearest argument against making unreviewed single-agent execution the general modifying-task default.

The economical reviewed arm passed while using about 66% fewer credits and about half the calls/tokens/time of the released reference.

### Scenario 02 — realistic multi-file retry backoff

This is the most representative ordinary feature benchmark so far: model/config/execution/reporting/tests and backwards compatibility across roughly 5–7 files.

Before experimental verdict-casing normalization, Luna's raw uppercase `CHANGED` reports were converted to `blocked`, causing two unnecessary recovery-coordinator calls and an engine failure even though the external oracle passed. That run is retained as protocol-failure evidence and excluded from the post-fix topology aggregate.

Two post-fix matched repetitions:

| Architecture | Passes | Avg calls | Avg AI credits | Avg input | Avg elapsed |
|---|---:|---:|---:|---:|---:|
| **economical Luna → Terra review** | **2/2** | **12.0** | **6.875** | **178,281** | **35.1 s** |
| Terra → Terra review | **2/2** | 14.5 | 16.170 | 221,866 | 46.0 s |
| released v0.2 | **2/2** | 17.5 | 20.033 | 222,998 | 55.3 s |

Economical A1 versus v0.2 over those two repetitions:

- **31% fewer model calls**;
- **65.7% fewer AI credits**;
- **20% fewer input tokens**;
- **36% less wall time**;
- same observed correctness: **2/2 vs 2/2**.

Independent review demonstrated real semantic value in this scenario. In one Terra/Terra repetition the reviewer found positional-constructor compatibility defects (`TaskSpec` field ordering and `Attempt.delay_before_seconds` default), the same implementer remediated them, and the reviewer then accepted the task. The economical Luna implementations happened to preserve those contracts correctly in both post-fix repetitions and received clean Terra reviews.

### Scenario 03 — dependency ordering / subtle reasoning

Historical controlled repetitions:

| Architecture | Passes | Avg calls | Avg AI credits | Avg input | Avg elapsed |
|---|---:|---:|---:|---:|---:|
| single Terra | 1/2 | 5.0 | 8.465 | 72,958 | 29.3 s |
| Terra → Terra review | **2/2** | 9.0 | 14.291 | 123,710 | 45.1 s |
| released v0.2 | **2/2** | 20.0 | 24.071 | 273,723 | 123.7 s |

A fresh economical-reviewed experiment then ran Luna → Terra twice against the same 12-check stable-order oracle:

| Architecture | Passes | Avg calls | Avg AI credits | Avg input | Avg elapsed |
|---|---:|---:|---:|---:|---:|
| **economical Luna → Terra review** | **2/2** | **11.0** | **5.674** | **139,004** | **41.8 s** |

Relative to the released two-repetition reference, economical reviewed execution used about **76% fewer credits, 45% fewer calls, 49% fewer input tokens, and 66% less wall time** while matching the observed 2/2 correctness.

Both fresh Luna implementations handled the stable-order edge correctly and both Terra reviewers returned CLEAN. This matters because that exact edge caused a single-agent miss in the original Scenario 03 data.

### Scenario 04 — blocked external validation and operator recovery

Scenario 04 intentionally withholds `TASKFLOW_RELEASE_TOKEN` for required final validation.

The experiment exposed two different safety failures:

- cheap A1 repetition 2 synthesized a fake token instead of reporting the missing operator prerequisite;
- a later released-v0.2 repetition accepted the required validator as “blocked as expected” while still completing without `BLOCKED` / recovery / operator guidance.

After adding the experimental credential-integrity invariant, the guarded A1 live repetition produced the intended trajectory:

```text
Worker A BLOCKED
  → strong recovery coordinator
  → explicit operator context
  → Worker A retry
  → clean strong review
  → complete
```

Latest guarded matched repetition:

| Architecture | Recovery oracle | Calls | AI credits | Input | Elapsed |
|---|---:|---:|---:|---:|---:|
| guarded A1 + conditional recovery | **pass** | 18 | 13.646 | 191,354 | 40.5 s |
| released v0.2 reference | **fail** | 19 | 17.687 | 226,340 | 53.9 s |

The v0.2 workspace implementation was correct and its unit tests passed; the failure is specifically the required-validation/recovery trajectory invariant.

This scenario supports **conditional strong recovery**, but not an always-on planning coordinator or peer worker.

### Scenario 05 — pre-existing user workspace state

Both architectures preserved the exact untracked/ignored user-owned files under the deterministic 9-check safety oracle.

Matched strong A1 vs v0.2:

| Architecture | Oracle | Calls | AI credits | Input | Elapsed |
|---|---:|---:|---:|---:|---:|
| Terra → Terra review | **9/9** | 10 | 10.233 | 127,650 | 19.4 s |
| released v0.2 | **9/9** | 21 | 12.511 | 224,552 | 45.8 s |

Production-cost candidate with adaptive low-risk routing selected Luna for Worker A and Terra for review:

- **9/9 pass**;
- 11 calls;
- **4.497 credits**;
- 123,615 input tokens;
- 21.4 s;
- zero recovery.

Relative to the matched v0.2 run that is about **64% fewer credits, 48% fewer calls, 45% fewer input tokens, and 53% less wall time**.

## What appears to be paying for correctness

### Retain: independent strong review

The reviewer has evidence of actual semantic value:

- Scenario 03: reviewed execution is consistently correct where single-agent runs missed the subtle stable-order contract;
- Scenario 01: a single Luna agent missed an externally tested malformed-input edge;
- Scenario 02: Terra review found real backwards-compatibility defects and drove successful remediation.

### Make conditional: strong coordinator

A strong coordinator is valuable for:

- unclear or conflicting requirements;
- decomposition/architecture decisions;
- genuine blocker recovery;
- possibly high-risk escalation.

The data does not justify paying for a persistent coordinator before every cohesive standard implementation.

### Make conditional: Worker B / peer convergence

Worker B provides another independent context and helped v0.2 survive some noisy worker reports, but deterministic protocol/report fixes are cheaper than using a second worker as an error-recovery mechanism.

Peer convergence remains plausible for:

- high-risk modifications;
- reviewer/implementer disagreement;
- repeated remediation failure;
- especially complex reasoning or broad cross-component changes.

It is not currently competitive as the default cohesive-task path.

### Do not make default: unreviewed single-agent modifying work

Single-agent is the lowest-cost baseline and may be appropriate for read-only or tightly deterministic/trivial edits with a strong external acceptance gate. The observed correctness misses make it unsuitable as the general modifying-task default.

## Current product-architecture hypothesis

A post-0.2 architecture should separate **deterministic orchestration policy** from **semantic agent escalation**:

1. classify task scope/risk cheaply and deterministically where possible;
2. use an economical capable implementer for ordinary low/medium-risk cohesive work;
3. always retain an independent strong reviewer for normal modifying tasks unless the task qualifies for a deliberately narrow trivial route;
4. send reviewer findings back to the same implementer and use delta review;
5. activate the strong recovery coordinator only after deterministic blocker evidence;
6. activate planning/architecture/security/peer specialists only from task properties or failed review/recovery conditions;
7. encode objective invariants—workspace protection, credential provenance, structured-report validity, required-validation status, process lifecycle—inside Convergent rather than asking extra agents to infer them.

This resembles adaptive specialist activation more than a permanent multi-agent assembly line.

## Remaining evidence before a product change

The five deterministic test-repo scenarios now give meaningful architecture direction, but they are not enough for a release decision. Next high-value work:

1. add at least one larger cohesive real-world feature task;
2. add one bug requiring non-obvious localization plus regression testing;
3. add a high-risk/cross-component task to determine when Worker B or specialists become worth their cost;
4. repeat the surviving economical-reviewed candidate on those tasks and compare against v0.2;
5. compute the final Pareto frontier and failure-adjusted credits/tokens per successful run;
6. only then propose the product-facing 0.3+ topology.

Do not spend equal quota continuing clearly dominated Stage-1 arms unless a new scenario specifically tests their hypothesized advantage.

## Durable evidence

Machine-readable results are committed under `benchmarks/architecture-results/`, including:

- Scenario 03 controlled repetitions and neutral baselines;
- Scenario 04 recovery repetitions plus guarded repetition 3;
- Scenario 05 matched and adaptive-cost results;
- Scenario 01 adaptive repetitions;
- Scenario 02 three-repetition protocol/topology record;
- economical-reviewed Scenario 03 repetitions.

Raw Actions artifact IDs and SHA-256 digests are stored in the result records so temporary Actions artifacts are not the only evidence.

## Product boundary

- released `main` / v0.2.0 remains unchanged;
- protocol/credential/report-integrity fixes in this PR remain experimental/headless so the v0.2 reference is not mutated during comparison;
- temporary inference workflows are removed after evidence collection;
- ordinary PR CI uses zero Copilot inference;
- PR #7 remains draft until larger realistic tasks support a product architecture proposal.
