# Topology benchmark tournament

This benchmark is deliberately separate from Convergent's production routing. It answers a narrower question: which orchestration topology produces the most accepted changes for the least inference cost on identical repository fixtures?

## Experimental arms

- `terra-solo` — one Terra coding session, no coordinator, Explore, peer, or strong reviewer. Independent benchmark tests/oracles decide correctness.
- `luna-terra` — Luna implementer plus Terra strong review; no Worker B.
- `luna-terra-compact` — Luna + Terra with compact standard benchmark prompts.
- `luna-terra-lean` — Luna + Terra with lean prompts/tool surface.
- `luna-terra-structured` — lean Luna + Terra prompts with the natural structured read/edit/managed-command capability set used by the finalist experiments.
- `luna-terra-capable` — lean prompts with the fuller production-like capability surface.
- `luna-peer-terra` — Luna implementer, a cheap/diversified read-only peer critic, then Terra strong review. Peer findings return to Worker A; the peer never edits.
- `luna-ab-terra` — modifying A/B convergence followed by Terra strong review.
- `terra-terra` — Terra implementer plus independent Terra strong review.

Coordinator/recovery/architect roles, when a Convergent topology actually needs them, are pinned to Terra for the experiment. Worker A is explicitly Luna or Terra according to the arm. No arm may silently degrade a pinned model to Copilot `auto`; the normal headless model preflight remains authoritative.

## Acceptance before efficiency

A scored run is accepted only when all three gates are green:

1. the topology runner reaches `status=complete`;
2. the target repository's independent unittest suite passes;
3. the registered deterministic scenario oracle passes.

Inference spent on an ordinary failed run is not discarded from the denominator. The primary cost metrics are therefore:

- AI credits per accepted run = total scored credits spent / accepted runs;
- input tokens per accepted run = total scored input tokens spent / accepted runs.

This intentionally penalizes architectures that are cheap but unreliable.

Explicit provider/infrastructure invalidation is different from a model-quality failure. The tournament currently recognizes the concrete Copilot `You have exceeded your monthly quota` condition, quarantines those run artifacts before scoring, and emits a separate infrastructure-invalid JSON/Markdown report. No other implementation, target-test, oracle, budget, or ordinary model failure is silently excluded.

The report also records acceptance rate, calls, elapsed time, peak context, and a Pareto frontier over acceptance rate (higher is better), credits/success, and input tokens/success (lower is better). It does not collapse quality and cost into a single arbitrary weighted score.

## Automated workflow

`Convergent Topology Tournament` runs each topology/scenario/repeat combination with `strategy.max-parallel: 1`, so one Copilot benchmark identity is not intentionally load-tested by parallel architecture arms.

A normal PR activation is intentionally small: one `luna-terra-structured` Scenario 03 smoke run. Larger architecture comparisons are explicit `workflow_dispatch` experiments with JSON arrays for topologies, scenarios, and repeat numbers. A serious finalist comparison should normally use at least three repeats across semantically different scenario classes.

Scenario 07 and 08 use dedicated seeded fixture branches. Scenario 03 uses the clarified review-contract fixture branch in which the cycle-diagnostic requirement is explicit; the deterministic oracle is unchanged. Other registered scenarios retain their independent deterministic oracles.

Unexpected operator input fails closed unless a scenario explicitly supplies deterministic scripted benchmark answers. No person is required during a run.

## Reviewer-protocol finding

The benchmark isolated a quality-gate defect rather than a model-pairing defect.

The original repeated finalist comparison produced the same acceptance for Terra solo and structured Luna→Terra: both were 1/3 on Scenario 03 and 3/3 on Scenario 08. Trace analysis showed complementary strengths: Terra solo repeatedly missed the subtle global stable-order requirement, while Luna implementations generally handled that semantic invariant but sometimes left narrower parser/diagnostic contract defects. Terra-as-reviewer did not reliably catch those Luna defects because the review protocol tended to anchor on obvious missing-test findings and then verify only the remediation delta.

Successive benchmark-only review-contract experiments showed that an acceptance checklist alone was insufficient. The decisive change was requiring the strong reviewer to distinguish implementation evidence from test evidence and to attempt bounded falsification of central semantic invariants with property-oriented checks or structurally distinct witnesses. When algorithmic/semantic remediation changes the implementation, CLEAN additionally requires fresh evidence rather than only replaying the original failing example.

With that strengthened generic reviewer contract:

- Tournament #19: Scenario 03 `luna-terra-structured` **3/3 accepted**, versus the earlier 1/3 structured and 1/3 Terra-solo baselines.
- Tournament #20 generalization: Scenarios 01 and 08 **6/6 accepted** combined. The reviewer found real parser-contract defects where present and returned CLEAN without manufactured findings on all three path-containment/security runs.
- Combined strengthened evidence: **9/9 accepted across Scenarios 01, 03, and 08**.

The production candidate is deliberately implemented separately from this benchmark harness. Benchmark-specific examples and hidden-oracle cases are not copied into the production reviewer prompt.

## Invalid final head-to-head

Tournament #21 attempted a fresh 18-run Terra-solo versus strengthened structured Luna→Terra comparison across Scenarios 01/03/08 × three repeats. It is not a valid head-to-head because the shared Copilot identity exhausted its monthly quota during the matrix.

Artifact-level classification is unambiguous:

- 3/18 valid samples: Terra-solo Scenario 01 repeats 1–3, all accepted;
- 15/18 infrastructure-invalid samples: every other run contains the explicit monthly-quota provider error;
- 14 of the invalid samples stop before any model call; Terra Scenario 03 repeat 1 reaches three calls before the quota rejection.

The raw #21 aggregate must therefore not be used for topology ranking. The valid fresh Terra Scenario 01 subset was 3/3 accepted at about 5.69 credits/run and roughly 12.9 seconds median wall time.

## Local single-run invocation

```bash
node src/headless/topology-cli.js \
  --workspace /path/to/convergent-test-repo \
  --prompt-file /path/to/convergent-test-repo/benchmarks/08-artifact-path-containment.md \
  --output-dir /tmp/topology-run \
  --topology luna-terra-structured \
  --flow fast \
  --audit-level full
```

Build a report over a directory tree containing already-scored-valid tournament run outputs:

```bash
node src/headless/topology-report.js /tmp/topology-results
```

The Actions workflow runs `topology-validity.js` first so explicit infrastructure-invalid artifacts do not contaminate that scored input tree.

## Current architecture decision

Do not change production routing merely because one stochastic run is cheaper.

Current evidence supports these conclusions:

- `terra-solo` remains a valuable speed/cost baseline and is highly competitive on straightforward tasks; the fresh Scenario 01 subset was 3/3 and materially faster than reviewed orchestration.
- `luna-terra-structured` with the strengthened strong-review contract is the leading candidate for normal reviewed implementation work because it converted the difficult Scenario 03 result from 1/3 to 3/3 and generalized 6/6 on two different scenario classes.
- the evidence does **not** currently justify adding a peer critic or returning to modifying A/B convergence for ordinary standard tasks;
- a production reviewer change should retain bounded Fast-flow scope and use independent property/boundary validation only when a concrete correctness concern or central semantic invariant lacks discriminating evidence;
- before production promotion, validate the generalized reviewer contract through the exact production reviewer prompt/session path when provider quota is available. Do not tune the prompt further against the benchmark before that check.

If future valid repeated evidence shows Terra solo is both equally reliable and cheaper on the difficult semantic/security classes, simplify Convergent rather than defending orchestration complexity. If additional peer/A-B machinery demonstrates unique repeatable acceptance value on a specific high-risk class, retain it only for that class.

The benchmark is intended to falsify architecture assumptions, not confirm them.
