# Convergent architecture benchmarks

This document defines the post-0.2 experimental topology track from issue #6. It is intentionally headless-only: released VS Code orchestration remains unchanged while benchmark data is collected.

## Principle

Treat orchestration topology and model policy as separate variables. A topology describes which roles execute and how they hand off. Model selectors remain ordinary headless options.

Every comparison should use the same benchmark prompt, target commit, starting workspace state, deterministic acceptance oracle, tool/permission policy, reasoning mode, and outer safety budget unless that variable is explicitly under test.

Architecture failures are benchmark data, not harness failures. A failed deterministic oracle must not prevent later arms from running.

## Implemented initial topologies

### `convergent-v02`

Released 0.2 reference architecture:

```text
strong coordinator
      ↓
Worker A ↔ Worker B exact-fingerprint convergence
      ↓
strong reviewer
```

The experimental CLI delegates this arm to the unchanged `RecoveryConvergentEngine`.

### `single-agent`

One implementation agent receives the complete benchmark request as one fixed task and owns inspection, implementation, relevant validation, self-check, and final `report_pass`.

There is no coordinator, peer worker, or strong reviewer. The deterministic benchmark oracle remains external.

Useful model variants:

```bash
# explicit strong single-agent baseline
node src/headless/architecture-cli.js \
  --architecture single-agent \
  --worker-a strong \
  ...

# ordinary automatic-model baseline
node src/headless/architecture-cli.js \
  --architecture single-agent \
  --worker-a auto \
  ...
```

### `implementer-reviewer`

One implementer writes the patch. An independent strong reviewer inspects the exact current workspace. Findings go back to the same implementer for bounded remediation, then the same reviewer rechecks.

There is no coordinator and no Worker B / peer convergence.

```text
implementer
    ↓
strong reviewer
    ↕ bounded remediation
```

Controlled strong/strong variant:

```bash
node src/headless/architecture-cli.js \
  --architecture implementer-reviewer \
  --worker-a strong \
  --reviewer strong \
  ...
```

Production-cost candidate:

```bash
node src/headless/architecture-cli.js \
  --architecture implementer-reviewer \
  --worker-a adaptive \
  --reviewer strong \
  ...
```

## CLI example

```bash
node src/headless/architecture-cli.js \
  --architecture implementer-reviewer \
  --workspace /path/to/convergent-test-repo \
  --prompt-file /path/to/convergent-test-repo/benchmarks/03-dependency-ordering.md \
  --output-dir /tmp/convergent-architecture-run \
  --flow fast \
  --worker-a strong \
  --reviewer strong \
  --audit-level full \
  --max-model-calls 36 \
  --max-model-calls-per-turn 10 \
  --max-chat-requests 12 \
  --max-ai-credits 0
```

For topology comparisons, AI credits are measured output rather than the matching resource cap; use the same hard model-call/per-turn/request/time envelope for every arm. A non-zero engine-level soft credit policy is architecture-specific in 0.2 and would therefore be a confounder.

The output includes:

- `architecture.json` — topology id, active roles, and configured selectors;
- `models.json` — available model inventory, architecture-relevant preflight issues, and ignored unused-role issues;
- `result.json` — normalized run status, architecture metadata, actual session/model map, usage, stats, workspace snapshot, plan/task shape, and hard-budget state;
- full trajectory audit under `audit/`;
- `workspace.status` and `workspace.diff`.

`architecture-summary.js` combines one or more arm directories into normalized JSON and CSV rows:

```bash
node src/headless/architecture-summary.js \
  comparison.json comparison.csv \
  /tmp/run/single-terra \
  /tmp/run/implementer-reviewer-terra \
  /tmp/run/convergent-v02
```

## First controlled Scenario 03 repetition

Target baseline for every arm:

`convergent-test-repo@1f38b2606f306ef4902d6159e8c9b7f3d8fe9aef`

All arms used Fast mode and the same `36 total / 10 per agent turn / 12 request` hard envelope. Runs were sequential because the Copilot account quota counter is shared and parallel runs would contaminate request-delta measurements.

| Architecture | Actual models | Oracle | Calls | AI credits | Input tokens | Elapsed |
|---|---|---:|---:|---:|---:|---:|
| single-agent / strong | Terra | 11/12 ❌ | 5 | 8.664 | 73,436 | 32.3 s |
| implementer-reviewer / strong+strong | Terra → Terra | 12/12 ✅ | 9 | 14.810 | 126,910 | 42.6 s |
| convergent-v02 | Terra coord, Terra A, GPT-5.4 mini B, Terra review | 12/12 ✅ | 22 | 26.017 | 311,272 | 92.7 s |

Single Terra completed a cohesive implementation very efficiently but missed one subtle stable-topological-order requirement: it produced `z, a, base, m, dependent` instead of preserving `dependent` ahead of unconstrained `m` once `base` was satisfied.

The strong implementer-reviewer arm produced a correct implementation in its initial implementer pass; the independent Terra reviewer returned CLEAN without remediation. Relative to the released Convergent repetition, it used about **59% fewer model calls**, **43% fewer AI credits**, **59% fewer input tokens**, and **54% less wall time** while passing the same 12/12 oracle.

The released reference also passed 12/12. In this repetition it used coordinator + Worker A + Worker B + reviewer; Worker B needed two prompts before its accepted clean report, and the final reviewer was clean.

This is **one stochastic repetition**, not a product-architecture conclusion. It supports the hypothesis that independent strong review may buy much of the correctness benefit for cohesive standard tasks at lower cost, but at least one more paired repetition and nontrivial/recovery tasks are required before eliminating any arm.

The observed SDK chat-request quota snapshot was zero for these Pro runs, so request delta is currently not a trustworthy discriminating metric for this account/runtime. Model calls, tokens, credits, and wall time remain directly measured.

## Fair comparison order

Start with Scenario 03 because it is a cohesive implementation task with a deterministic 12-check oracle and no intentional environment blocker.

Initial controlled comparison:

1. `single-agent`, Worker A = `strong`;
2. `implementer-reviewer`, Worker A = `strong`, reviewer = `strong`;
3. `convergent-v02`, released model policy.

Then add:

4. `single-agent`, Worker A = `auto`;
5. `implementer-reviewer`, Worker A = `adaptive`, reviewer = `strong`.

Do not conclude from one stochastic run. Use repeated paired runs from identical target commits and compare pass rate, model calls, tokens, AI credits, Copilot request delta when available, wall time, duplicate repository reads, repeated test commands, and reviewer-found defects.

## Planned topology arms

Not implemented in the first slice:

- two strong peers without third reviewer;
- two strong peers plus reviewer;
- fixed requirements → architect → implementer → tester → reviewer pipeline;
- scope/risk-adaptive specialist activation;
- isolated parallel worktree/branch workers for genuinely decomposable tasks.

Those should be added only after the initial three-arm harness produces trustworthy normalized measurements.
