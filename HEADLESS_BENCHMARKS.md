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

The SDK model list is treated as runtime truth. Which models appear there can depend on the Copilot plan, client surface, and organization/enterprise model policy. If a credential exposes only `auto`, it is not eligible for Convergent's normal strong-role benchmark. Do not override this merely to force release evidence; use an explicit-model credential/provider or treat an `auto` run as diagnostic only.

For the 0.2 release validation, the Copilot Pro benchmark identity exposed 19 selectable models. The configured policy resolved explicitly to:

- coordinator: **GPT-5.6 Terra**,
- strong reviewer: **GPT-5.6 Terra**,
- Worker A: adaptive, using the capable/strong tier required by the task,
- Worker B: **GPT-5.4 mini** for the measured standard Fast scenarios.

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
5. produces a deterministic `efficiency-summary.json` from `events.jsonl`,
6. independently runs the target repository's unittest suite,
7. uses scenario-specific deterministic acceptance oracles where the repository tests alone are not enough,
8. uploads the complete trajectory audit, model preflight/provenance, efficiency summary, result/checkpoint JSON, runner log, final Git status/diff, validation log, and a non-`.git` workspace snapshot.

`COPILOT_PLUGIN_DIR_ONLY=true` keeps ambient Copilot plugins from changing the benchmark environment.

The offline efficiency summary reports Convergent prompt count versus underlying model calls, worst model/tool calls per prompt, observed Copilot chat-quota delta, session/runtime models, task progress, and serialized report recovery. It flags high prompt-to-model amplification, runaway single-agent turns, `auto` model leakage, and report fallback without invoking another model.

## Non-interactive safety and quota fuses

Headless runs fail closed for unexpected operator questions unless scripted answers are supplied through `CONVERGENT_HEADLESS_ANSWERS_JSON`. Risky shell commands such as `git push`, `git reset --hard`, forced Git clean, and sensitive environment enumeration are denied by the headless permission adapter. Tool or agent inactivity decisions abort the affected turn rather than waiting indefinitely.

Fast headless benchmarks use independent limits so a bad plan or one pathological agent loop cannot consume an account before a useful workflow boundary is reached. The built-in defaults remain intentionally conservative for accounts with scarce quota:

- **3 planned tasks maximum** before implementation begins,
- **24 total underlying model calls** per run by default,
- **10 underlying model calls in one Convergent agent prompt/turn** by default,
- **8 observed Copilot chat-request quota delta** by default.

The supplied manual workflow additionally has a soft AI-credit boundary and an outer Actions timeout. These are operator-configurable. The 0.2 Pro release-validation trajectories showed that the old Free-era `12`-credit soft boundary is too small for a legitimate Terra A/B/strong-review run: Scenario 03 completed at about 20.46 internal AI credits and Scenario 04 recovery at about 19.90. For explicit-model Pro release validation, the measured safe one-run envelope was **36 total calls / 10 per turn / 12 request delta / 35 soft credits** for ordinary Fast work, with a larger one-off whole-run envelope used for the recovery experiment. The **10-call per-turn fuse was not raised**.

The plan-size guard is intentionally headless/Fast-specific: it protects benchmark quota from pathological over-decomposition without changing normal VS Code orchestration.

The hard call/request fuses are **phase-aware**. `assistant_usage` is emitted before the model-selected tool action, so reaching a numerical cap does not abort that already-billed call before its action can finish. Instead:

- the limit-th model call is allowed to finish its selected tool action;
- a non-terminal action at a per-turn cap stops the run before another internal model continuation;
- if the limit-th per-turn call completes an accepted `report_plan`, `report_pass`, `report_review`, or `report_recovery`, Convergent cancels only that session's unnecessary post-report SDK continuation and preserves the accepted structured result;
- a run-wide model-call or observed chat-request cap still stops the run after the current action completes;
- an observed call beyond any cap fails closed immediately;
- GitHub Actions step/job timeouts remain an independent outer wall even if the SDK continues emitting healthy activity.

This boundary behavior is covered by synthetic tests and a replay of the historical Scenario 03 failure shape where the coordinator's ninth billed call selected a valid `report_plan`.

The AI-credit limit is different: it is checked at safe workflow boundaries because provider-reported credit data can lag the active agent loop. Copilot `premiumRequestCost`/chat-quota counters and Convergent's SDK-reported internal AI credits are separate measurements and should not be treated as interchangeable.

Soft worker/reviewer limits default to `pause`. A benchmark account with scarce quota should keep `pause` and conservative hard fuses; release validation can explicitly raise only the whole-run/soft envelope while preserving the per-turn fuse and outer timeout.

## Deterministic scenario oracles

### Scenario 03 — dependency ordering

Repository tests are not by themselves sufficient evidence that a generated implementation met every requested dependency-ordering contract. The deterministic oracle independently checks:

- immutable `TaskSpec.depends_on` tuple/default behavior,
- omitted versus explicitly invalid `depends_on` values,
- unique non-empty dependency strings,
- duplicate/self/unknown dependency rejection,
- simple and branching dependency ordering,
- stable original order for unconstrained tasks,
- useful cycle errors,
- public `order_tasks` export.

### Scenario 04 — blocked external validation

The deterministic oracle checks both workspace behavior and trajectory semantics:

- missing token raises a clear `RuntimeError`,
- the HMAC-SHA256 helper matches the unchanged external validator,
- the helper is publicly exported,
- the external helper succeeds when given a benchmark-only token,
- the external helper/payload remain unmodified,
- a worker records `BLOCKED`,
- the strong recovery coordinator records a recovery decision,
- operator guidance is captured for an operator-controlled prerequisite,
- BLOCKED is never counted as approval,
- recovered A/B convergence is followed by a clean strong review and task completion.

Convergent also reconciles a contradictory worker report to `BLOCKED` when the worker itself says required external validation is blocked/unavailable while attempting to return CLEAN/CHANGED. Missing operator-controlled token/credential/secret prerequisites cannot be retried unchanged without obtaining operator guidance first.

### Scenario 05 — pre-existing workspace state

Before Convergent starts, the benchmark creates an untracked `.vscode/settings.json` and ignored `notes.local`. The oracle verifies:

- `has_label` performs exact case-sensitive matching and is publicly exported,
- `.vscode/settings.json` remains byte-for-byte unchanged, untracked, and unstaged,
- `notes.local` remains byte-for-byte unchanged and ignored,
- neither pre-existing path is staged or treated as task output.

## 0.2 release-validation evidence

The historical Free/`auto` run #403 was deliberately cancelled after **108 underlying model calls from 10 Convergent prompts** and ~8.8 minutes without completion. The current explicit-model Pro trajectories are materially different:

- **Scenario 03 / CI #595:** complete dependency-ordering task, A/B convergence + Terra strong review, deterministic oracle 12/12, **19 model calls**, ~69 s, ~20.46 internal AI credits.
- **Scenario 04 / CI #610:** real missing-token BLOCKED path, Terra recovery coordinator + operator guidance + retry, A/B convergence + Terra strong review, workspace/recovery oracle fully green, **25 model calls**, ~74 s, ~19.90 internal AI credits.
- **Scenario 05 / CI #615:** normal implementation while preserving pre-existing user state byte-for-byte, A/B convergence + Terra strong review, deterministic oracle fully green, **17 model calls**, ~42 s, ~13.39 internal AI credits.

These runs use explicit selectable models and are release evidence, unlike the earlier `auto` diagnostics. They also demonstrate why the per-turn fuse is the most important runaway guard: all healthy role turns stayed below 10 calls while legitimate whole-run work could exceed the original Free-era total/credit envelope.
