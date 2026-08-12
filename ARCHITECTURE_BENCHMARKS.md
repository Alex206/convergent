# Convergent architecture benchmarks

This document defines the post-0.2 experimental topology track from issue #6. It is intentionally headless-only: released VS Code orchestration remains unchanged while benchmark data is collected.

## Principle

Treat orchestration topology and model policy as separate variables. A topology describes which roles execute and how they hand off. Model selectors remain ordinary headless options.

Every comparison should use the same benchmark prompt, target commit, starting workspace state, deterministic acceptance oracle, tool/permission policy, reasoning mode, and outer safety budget unless that variable is explicitly under test.

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
  --max-ai-credits 35
```

The output includes:

- `architecture.json` — topology id, active roles, and configured selectors;
- `models.json` — available model inventory and resolved strong-role policy;
- `result.json` — normalized run status, architecture metadata, usage, stats, workspace snapshot, plan/task shape, and hard-budget state;
- full trajectory audit under `audit/`;
- `workspace.status` and `workspace.diff`.

## Fair comparison order

Start with Scenario 03 because it is a cohesive implementation task with a deterministic 12-check oracle and no intentional environment blocker.

Initial controlled comparison:

1. `single-agent`, Worker A = `strong`;
2. `implementer-reviewer`, Worker A = `strong`, reviewer = `strong`;
3. `convergent-v02`, released model policy.

Then add:

4. `single-agent`, Worker A = `auto`;
5. `implementer-reviewer`, Worker A = `adaptive`, reviewer = `strong`.

Do not conclude from one stochastic run. Use repeated paired runs from identical target commits and compare pass rate, model calls, tokens, AI credits, Copilot request delta, wall time, duplicate repository reads, repeated test commands, and reviewer-found defects.

## Planned topology arms

Not implemented in the first slice:

- two strong peers without third reviewer;
- two strong peers plus reviewer;
- fixed requirements → architect → implementer → tester → reviewer pipeline;
- scope/risk-adaptive specialist activation;
- isolated parallel worktree/branch workers for genuinely decomposable tasks.

Those should be added only after the initial three-arm harness produces trustworthy normalized measurements.
