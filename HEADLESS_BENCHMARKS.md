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

The SDK model list is treated as runtime truth. Which models appear there can depend on the Copilot plan, client surface, and organization/enterprise model policy. If a credential exposes only `auto`, it is not eligible for Convergent's normal strong-role benchmark. Do not override this by explicitly selecting `auto` merely to make a benchmark run; doing so measures a different orchestration/model policy.

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
7. for Scenario 03, runs `src/headless/scenario03-acceptance.js` as a deterministic contract oracle in addition to repository tests,
8. uploads the complete trajectory audit, model preflight, efficiency summary, result/checkpoint JSON, runner log, final Git status/diff, validation log, and a non-`.git` workspace snapshot.

`COPILOT_PLUGIN_DIR_ONLY=true` keeps ambient Copilot plugins from changing the benchmark environment.

The offline efficiency summary reports Convergent prompt count versus underlying model calls, worst model/tool calls per prompt, observed Copilot chat-quota delta, session/runtime models, task progress, and serialized report recovery. It flags high prompt-to-model amplification, runaway single-agent turns, `auto` model leakage, and report fallback without invoking another model.

## Bounded diagnostic modes

When the benchmark identity is not eligible for the configured strong/adaptive model policy, CI may run deliberately **non-authoritative** `auto` diagnostics to isolate orchestration mechanics without claiming release-quality benchmark evidence.

The current diagnostics are label-triggered and one-shot:

- `headless-auto-smoke`: plan-only. It stops immediately after an accepted Fast plan and verifies that no task started.
- `headless-auto-worker-a-smoke`: coordinator plus exactly one Worker A pass. It stops after Worker A reports and verifies that no Worker B or strong-review prompt was sent.

The label should be removed immediately after the run is queued. These diagnostics use smaller call/request/credit caps and an explicit GitHub Actions step timeout. They do not substitute for the normal strong-role benchmark.

## Non-interactive safety and quota fuses

Headless runs fail closed for unexpected operator questions unless scripted answers are supplied through `CONVERGENT_HEADLESS_ANSWERS_JSON`. Risky shell commands such as `git push`, `git reset --hard`, forced Git clean, and sensitive environment enumeration are denied by the headless permission adapter. Tool or agent inactivity decisions abort the affected turn rather than waiting indefinitely.

Fast headless benchmarks use independent limits so a bad plan or one pathological agent loop cannot consume an account before a useful workflow boundary is reached:

- **3 planned tasks maximum** before implementation begins; a larger Fast plan records the accepted plan and stops before Worker A is started,
- **24 total underlying model calls** per run by default,
- **10 underlying model calls in one Convergent agent prompt/turn** by default,
- **8 Copilot chat requests of observed account-quota delta** by default,
- **12 reported AI credits** as a soft safe-boundary budget in the supplied GitHub workflows,
- **15 minutes** as the outer manual workflow timeout.

The plan-size guard is intentionally headless/Fast-specific: it protects benchmark quota from pathological over-decomposition without changing normal VS Code orchestration.

The hard call/request fuses are **phase-aware**. `assistant_usage` is emitted before the model-selected tool action, so reaching a numerical cap does not abort that already-billed call before its action can finish. Instead:

- the limit-th model call is allowed to finish its selected tool action;
- a non-terminal action at a per-turn cap stops the run before another internal model continuation;
- if the limit-th per-turn call completes an accepted `report_plan`, `report_pass`, `report_review`, or `report_recovery`, Convergent cancels only that session's unnecessary post-report SDK continuation and preserves the accepted structured result;
- a run-wide model-call or observed chat-request cap still stops the run after the current action completes;
- an observed call beyond any cap fails closed immediately;
- GitHub Actions step/job timeouts remain an independent outer wall even if the SDK continues emitting healthy activity.

This boundary behavior is covered by synthetic tests and a replay of the historical Scenario 03 failure shape where the coordinator's ninth billed call selected a valid `report_plan`.

The AI-credit limit is different: it is checked at safe workflow boundaries because provider-reported credit data can lag the active agent loop.

Soft worker/reviewer limits default to `pause`. The workflow exposes a `limit_policy` input when an intentionally more autonomous benchmark is desired. A benchmark account with scarce quota should keep `pause` and conservative hard fuses.

## Scenario 03 acceptance oracle

Scenario 03's repository tests are intentionally a benchmark surface and are not by themselves sufficient evidence that a generated implementation met every requested dependency-ordering contract. The deterministic acceptance probe independently checks:

- immutable `TaskSpec.depends_on` tuple/default behavior,
- omitted versus explicitly invalid `depends_on` values,
- unique non-empty dependency strings,
- duplicate/self/unknown dependency rejection,
- simple and branching dependency ordering,
- stable original order for unconstrained tasks,
- useful cycle errors,
- public `order_tasks` export.

The probe invokes no model and is used as benchmark/diagnostic evidence, not as production TaskFlow code.
