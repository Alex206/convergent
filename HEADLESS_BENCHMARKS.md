# Headless Convergent benchmarks

Convergent can run its orchestration core without the VS Code frontend. The headless path is intended for reproducible benchmark/regression runs; it is not the future remote-product frontend described for 0.4.0.

## What is shared with VS Code

The headless runner uses the same `RecoveryConvergentEngine`, `SessionFactory`, model routing, A/B convergence, strong-review gate, blocker recovery, workspace fingerprinting, and trajectory audit as the extension. Only the frontend/permission/input adapters are different.

Headless runs deliberately keep their output directory outside the target Git repository. Audit files inside the target worktree would become untracked task state and invalidate Convergent's workspace fingerprints.

## Local invocation

A normal Node.js process uses the Copilot SDK stdio runtime. Provide a Copilot credential through the environment, then run:

```bash
export COPILOT_GITHUB_TOKEN=...
export COPILOT_PLUGIN_DIR_ONLY=true
node src/headless/cli.js \
  --workspace /path/to/convergent-test-repo \
  --prompt-file /path/to/convergent-test-repo/benchmarks/03-dependency-ordering.md \
  --output-dir /tmp/convergent-benchmark \
  --flow fast \
  --audit-level full
```

The SDK also recognizes `GH_TOKEN` and `GITHUB_TOKEN`, but `COPILOT_GITHUB_TOKEN` is preferred for CI because the credential's purpose is explicit.

## Model eligibility preflight

A deterministic benchmark must not silently turn a configured `strong` or adaptive role into Copilot `auto`. Before creating any agent session, the headless runner calls `listModels()`, resolves every configured role, writes `models.json`, and fails closed if a required coordinator, reviewer, or adaptive worker routing tier would fall back to `auto`.

For diagnosis without spending an agent prompt, run:

```bash
node src/headless/model-preflight.js /tmp/convergent-models.json
```

The models-only preflight calls `listModels()` and does not create a Copilot agent session or send a prompt. CI can run the same operation with the temporary `headless-model-preflight` PR label and uploads the resulting JSON. Remove the label after inspection.

If the credential exposes only `auto`, it is not eligible for Convergent's normal strong-role benchmark. Do not override this by explicitly selecting `auto` merely to make a benchmark run; doing so measures a different orchestration/model policy.

## GitHub Actions

The benchmark workflows deliberately use two separate credentials:

- `COPILOT_GITHUB_TOKEN`: a token for a GitHub identity with Copilot entitlement. It is used only by the Copilot SDK runtime.
- `BENCHMARK_REPO_TOKEN`: a fine-grained token restricted to `Alex206/convergent-test-repo` with read-only repository **Contents** access. It is used only to check out the private benchmark target.

Keeping these permissions separate avoids broadening the Copilot token merely to cross a private-repository boundary.

The `Convergent Benchmark` workflow is manually dispatchable after both repository Actions secrets are configured. A benchmark path such as `benchmarks/03-dependency-ordering.md` selects the scenario.

The workflow:

1. checks out this Convergent revision and a clean `convergent-test-repo` target,
2. extracts only the benchmark's `## Prompt` fenced block,
3. verifies that configured role selectors resolve to explicit eligible models,
4. runs the same Convergent orchestration core headlessly,
5. independently runs the target repository's unittest suite,
6. uploads the complete trajectory audit, model preflight, result/checkpoint JSON, runner log, final Git status/diff, validation log, and a non-`.git` workspace snapshot.

`COPILOT_PLUGIN_DIR_ONLY=true` keeps ambient Copilot plugins from changing the benchmark environment.

## Non-interactive safety and quota fuses

Headless runs fail closed for unexpected operator questions unless scripted answers are supplied through `CONVERGENT_HEADLESS_ANSWERS_JSON`. Risky shell commands such as `git push`, `git reset --hard`, and forced Git clean are denied by the headless permission adapter. Tool or agent inactivity decisions abort the affected turn rather than waiting indefinitely.

Fast headless benchmarks use independent limits so one pathological agent loop cannot consume an account before a task boundary is reached:

- **24 total underlying model calls** per run by default,
- **10 underlying model calls in one Convergent agent prompt/turn** by default,
- **8 Copilot chat requests of observed account-quota delta** by default,
- **12 reported AI credits** as a soft safe-boundary budget in the supplied GitHub workflows,
- **15 minutes** as the outer manual workflow timeout.

The first three are hard headless fuses: when breached, Convergent aborts active sessions immediately and records the budget breach. The AI-credit limit is different: it is checked at safe workflow boundaries because reported credit data can lag the active agent loop.

Soft worker/reviewer limits default to `pause`. The workflow exposes a `limit_policy` input when an intentionally more autonomous benchmark is desired. A benchmark account with scarce quota should keep `pause` and conservative hard fuses.
