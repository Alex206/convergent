# Topology benchmark tournament

This benchmark is deliberately separate from Convergent's production routing. It answers a narrower question: which orchestration topology produces the most accepted changes for the least inference cost on identical repository fixtures?

## Experimental arms

- `terra-solo` — one Terra coding session, no coordinator, Explore, peer, or strong reviewer. Independent benchmark tests/oracles decide correctness.
- `luna-terra` — Luna implementer plus Terra strong review; no Worker B.
- `luna-peer-terra` — Luna implementer, a cheap/diversified read-only peer critic, then Terra strong review. Peer findings return to Worker A; the peer never edits.
- `luna-ab-terra` — current modifying A/B convergence followed by Terra strong review.
- `terra-terra` — Terra implementer plus independent Terra strong review.

Coordinator/recovery/architect roles, when a Convergent topology actually needs them, are pinned to Terra for the experiment. Worker A is explicitly Luna or Terra according to the arm. No arm may silently degrade a pinned model to Copilot `auto`; the normal headless model preflight remains authoritative.

## Acceptance before efficiency

A run is accepted only when all three gates are green:

1. the topology runner reaches `status=complete`;
2. the target repository's independent unittest suite passes;
3. the registered deterministic scenario oracle passes.

Inference spent on a failed run is not discarded from the denominator. The primary cost metrics are therefore:

- AI credits per accepted run = total credits spent / accepted runs;
- input tokens per accepted run = total input tokens spent / accepted runs.

This intentionally penalizes architectures that are cheap but unreliable.

The report also records acceptance rate, calls, elapsed time, peak context, and a Pareto frontier over acceptance rate (higher is better), credits/success, and input tokens/success (lower is better). It does not collapse quality and cost into a single arbitrary weighted score.

## Automated workflow

`Convergent Topology Tournament` runs each topology/scenario/repeat combination from a fresh checkout with `strategy.max-parallel: 1`, so one Copilot benchmark identity is not intentionally load-tested by parallel architecture arms.

Default smoke screen:

- topologies: Terra solo, Luna+Terra, Luna+read-only-peer+Terra, current Luna+A/B+Terra;
- scenarios: 01 small feature, 03 dependency ordering, 08 high-risk path containment;
- one repeat.

The workflow accepts JSON arrays for topologies, scenarios, and repeat numbers. A serious finalist comparison should normally use at least three repeats and include scenarios 03, 06, 07, and 08.

Scenario 07 and 08 use their dedicated seeded fixture branches. Scenarios 03/04/05 retain their existing deterministic oracles; the tournament adds independent Scenario 07 generator-lifetime and Scenario 08 path-containment oracles.

Unexpected operator input fails closed unless a scenario explicitly supplies deterministic scripted benchmark answers. No person is required during a run.

## Local single-run invocation

```bash
node src/headless/topology-cli.js \
  --workspace /path/to/convergent-test-repo \
  --prompt-file /path/to/convergent-test-repo/benchmarks/08-artifact-path-containment.md \
  --output-dir /tmp/topology-run \
  --topology luna-peer-terra \
  --flow fast \
  --audit-level full
```

Build a report over any directory tree containing tournament run outputs:

```bash
node src/headless/topology-report.js /tmp/topology-results
```

## Decision rule

Do not change production routing merely because one stochastic run is cheaper.

A topology is a candidate for production only when it survives deterministic acceptance and repeated runs. In particular:

- if `luna-terra` matches the high-risk acceptance of A/B convergence, prefer the simpler topology;
- if the read-only peer critic recovers security/edge-case defects that `luna-terra` misses at materially lower cost than A/B convergence, prefer the critic topology for the relevant risk class;
- if Terra solo is both more reliable and cheaper per accepted result, simplify Convergent rather than defending orchestration complexity;
- if A/B convergence demonstrates unique repeatable acceptance value on high-risk scenarios, retain it only for those risk classes.

The benchmark is intended to falsify architecture assumptions, not confirm them.
