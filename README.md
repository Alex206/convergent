# Convergent

Convergent is a VS Code extension that turns GitHub Copilot into an adaptive, deterministic multi-agent coding workflow. Convergent decides which specialist roles are worth paying for, keeps correctness-critical invariants in application code, and escalates assurance when the task actually needs it.

```text
User request
   ↓
Deterministic request/preflight boundary
   ├─ one explicit cohesive modifying task → deterministic plan
   └─ ambiguous / read-only / decomposable / architecture-high → strong planning coordinator
                                                     ↓
                                      optional software architect
                                                     ↓
Task
   ├─ read_only → strong coordinator result
   ├─ trivial   → Worker A → Worker B lightweight review; B changes → escalate
   ├─ standard  → Worker A → strong reviewer
   │               reviewer findings → same Worker A remediation → reviewer delta re-check
   └─ high_risk → Worker A ↔ diversified Worker B exact-fingerprint convergence
                   → strong reviewer

Any real deterministic BLOCKED state
   → fresh strong recovery coordinator on demand
   → operator prerequisite / retry / peer / pause decision
```

The central 0.3 design change is **adaptive specialist activation**. Strong planning, software-architecture review, Worker B peer convergence, and recovery are no longer permanent stages merely because they exist. Independent strong review remains the default gate for normal modifying work because the measured benchmark set repeatedly showed unique reviewer value.

The current 0.4 development line adds **Convergent-owned managed command execution**. Tests, builds, long-running commands, and subprocess-producing validation can run through `run_command`, which gives Convergent stable command/PID identity, bounded stdout/stderr capture, timeout/cancel state, and process-tree termination evidence. A stalled managed command may recover through a fresh agent session only after termination is proven; unproven termination fails closed.

## Current development capabilities

- Native VS Code Copilot Chat entry point: `@convergent`
- Deterministic single-task formation for explicit cohesive modifying requests, avoiding an unnecessary planning model call
- Strong read-only planning coordinator retained for ambiguity, decomposition, read-only investigation, architecture-high work, and cases outside the deterministic confidence boundary
- Independent `architectureSignificance` classification and a conditional strong read-only software architect
- Per-task `read_only`, `trivial`, `standard`, and `high_risk` routes with deterministic minimum assurance
- Standard modifying path: Worker A → strong reviewer → bounded same-A remediation/re-review
- High-risk or `routingMode=full` path: Worker A ↔ diversified Worker B exact-workspace convergence → strong reviewer
- Selectable execution flows: `@convergent /fast`, `/auto`, and `/thorough`
- Runtime model discovery and risk/flow-aware adaptive model selection; exact configured selectors remain hard overrides
- Exact workspace fingerprints over Git HEAD plus staged, unstaged, and untracked state
- Deterministic task-change manifests and revision-scoped validation evidence
- Product-boundary report integrity: case-insensitive verdict normalization, fail-closed unknown verdicts, contradictory-BLOCKED reconciliation, and required/external-validation reconciliation
- Operator-controlled credential provenance guard at the Copilot pre-tool boundary
- Shared credential authorization across normal and recovery sessions without persisting credential values
- Exact-revision + validator-identity carry of successful required-validation evidence
- `BLOCKED` recovery through a fresh strong read-only recovery coordinator created only when needed
- Manual **Convergent: Steer Active Agent** support using Copilot immediate steering
- Event-driven inactivity/tool-stall watchdogs rather than a total wall-clock turn timeout
- Convergent-owned `run_command` for managed tests/builds/long-running commands with PID identity, bounded stdout/stderr, timeout/cancel state, and process-tree termination evidence
- Proven managed-command stalls recover through an on-demand strong coordinator plus a fresh Worker/Reviewer session; unproven termination never auto-retries
- Safe workflow checkpoints with `@convergent /resume`
- Optional `convergent.taskCommits=safe` task-boundary checkpoint commits
- Rotating local trajectory audit with per-model-call token/cache/context/tool/review telemetry
- Task-start Git-status baselines that protect dirty/staged/untracked user state
- Headless benchmark harness with deterministic acceptance oracles, model-policy preflight, offline efficiency analysis, and hard runaway-loop fuses

## Requirements

- VS Code with GitHub Copilot Chat available
- Node.js 22.12+; Node.js 24 LTS is recommended for development
- A Git workspace
- A GitHub Copilot entitlement that can use the Copilot SDK

The Node.js Copilot SDK bundles the compatible Copilot CLI runtime. Authentication uses the SDK's normal Copilot authentication chain.

## Development

Dependencies are committed through `package-lock.json`; use a clean deterministic install:

```bash
npm ci
npm test
npm run check
npm run package
```

`npm run package` is intentionally **host-targeted**. It detects the current OS/architecture and passes the matching VS Code target (`win32-x64`, `linux-x64`, `darwin-arm64`, and so on) to `vsce`. This matters because the Copilot SDK installs a platform-specific native/CLI runtime. Do not invoke raw `vsce package` or override `--target` on the wrapper: a VSIX must be built on the same platform/architecture whose native Copilot dependencies it contains.

CI proves this end to end for Windows x64 and Linux x64, including the target declared in `extension.vsixmanifest` and the platform-specific Copilot runtime contained in the produced VSIX.

Press `F5` in VS Code to launch an Extension Development Host, open a Git repository, then use:

```text
@convergent Implement <your task>
```

Or run **Convergent: Start Workflow** from the command palette.

## Execution flows

The default `convergent.flow` is `auto`. A single run can override it in Chat:

```text
@convergent /fast Implement <task>
@convergent /auto Implement <task>
@convergent /thorough Implement <task>
```

| Flow | Intent | Behavior |
| --- | --- | --- |
| `fast` | Reach an accepted reviewed result quickly | Focused inspection/review and shorter autonomous tranches; asks sooner before spending more iterations |
| `auto` | Balanced default | Adaptive planning, routing, specialist activation, model selection, and configured soft tranches |
| `thorough` | Favor assurance over speed | Broader first review and larger convergence/review tranches |

Fast does **not** mean “always use the cheapest model” or “always use the strongest model.” Route/risk still controls the minimum assurance path, and exact user-configured model ids/names/presets override adaptation.

Planning is also adaptive. One explicit cohesive modifying request can become one deterministic task without a coordinator model call. Convergent falls back to strong planning when the request is read-only, ambiguous, presents unresolved choices/tradeoffs, is obviously decomposable into multiple independent tasks, has high architecture significance, crosses sensitive public/release boundaries that cannot be conservatively classified, or exceeds the bounded deterministic classifier.

## Adaptive routing and specialist activation

The default `convergent.routingMode` is `adaptive`. Route/risk and architecture significance are separate dimensions: a small security-boundary fix can be high-risk without needing a software architect, while a broad structural refactor can require the architect even if its immediate failure impact is not security-critical.

| Route | Intended use | Enforced workflow |
| --- | --- | --- |
| `read_only` | Inspection/explanation; no writes required | Strong planning/coordinator result only |
| `trivial` | Clearly low-risk docs/comment/text/wording change | Worker A → Worker B lightweight review; any B change escalates |
| `standard` | Normal source, scripts, tests, build/CI/config, feature or bug-fix work | Worker A → strong reviewer; same-A remediation and reviewer delta re-check when needed |
| `high_risk` | Security/auth/credentials, concurrency, migrations, destructive/release-sensitive or similar high-impact boundaries | Worker A ↔ diversified Worker B exact-fingerprint convergence → strong reviewer |

Set `convergent.routingMode` to `full` to force every modifying task through peer convergence plus strong review. Read-only work remains read-only.

A high `architectureSignificance` assessment adds a **read-only software architect before implementation**. The architect is explicitly prompted to prefer the simplest architecture compatible with the existing repository and to avoid abstraction or patterns without concrete need.

## Model selection and reasoning effort

Convergent discovers models from `client.listModels()` at runtime. Worker models are selected after task classification so route, risk, and flow can influence capability.

| Role | Default policy |
| --- | --- |
| Planning coordinator | Strong model, but only activated when planning is not safely deterministic |
| Software architect | Strong read-only specialist, only for architecture-significant modifying work |
| Worker A | Adaptive implementation model; measured standard path currently prefers GPT-5.6 Luna when available, while high-risk promotes capability |
| Worker B | Adaptive-diverse peer used for high-risk/full assurance, preferring a capable model different from Worker A |
| Strong reviewer | Strong independent reviewer; effort scales with task risk when supported |
| Recovery coordinator | Fresh strong read-only coordinator created only after a real deterministic BLOCKED state |

Exact model ids/names and explicit presets are overrides. `convergent.reasoningMode=adaptive` applies role/route-driven effort only when the selected model advertises support; `model-default` leaves reasoning effort untouched.

The headless benchmark path is stricter than the interactive product path: it records the runtime model list before inference and refuses a deterministic benchmark when configured non-auto strong/adaptive roles would silently degrade to Copilot `auto`.

## Reviewer behavior

Independent strong review is retained for normal modifying work. Across the measured architecture scenarios it repeatedly found issues that an unreviewed implementer missed or strengthened acceptance coverage enough to justify its cost.

For a standard task, reviewer findings return to the **same Worker A** for bounded remediation. The reviewer then verifies previous findings and inspects the remediation delta and directly affected callers/tests/interfaces. Worker B is not introduced merely because remediation was needed.

For high-risk/full tasks, A/B peer convergence happens before strong review. If reviewer remediation changes the exact workspace revision, the high-risk path can re-establish peer convergence before the final reviewer gate.

Successful required-validation evidence may be reused only when Convergent can prove the same validator identity already succeeded on the **exact workspace revision** under review. A later credential-less rerun cannot invalidate that exact-revision evidence, but a different validator or changed revision requires fresh evidence.

## Blocker recovery and credential provenance

A worker or strong-reviewer `BLOCKED` verdict is not approval. Convergent first reconciles the structured report against deterministic evidence. A genuine blocker checkpoints state and invokes a fresh strong read-only recovery coordinator.

Worker recovery actions are `peer`, `retry`, `ask_user`, or `pause`; reviewer recovery cannot bypass the required reviewer gate and therefore uses `retry`, `ask_user`, or `pause`. Peer fallback is offered only on routes that actually have a peer role.

Operator-controlled credentials are protected separately from model reasoning. If an agent tries to synthesize a named token/secret/password/credential rather than obtaining operator authorization, the pre-tool boundary denies the command. Recovery can authorize the **credential name** for the selected retry without storing the credential value in Convergent's provenance state.

If `ask_user` is selected, Convergent opens a native free-text question. The answer returns to the recovery coordinator, which chooses the final deterministic action. Recovery/operator guidance is injected once into the selected agent's next normal turn.

While an agent is working, **Convergent: Steer Active Agent** can inject an operator message into the active Copilot turn without restarting the task.

## Managed command execution and stalled-turn recovery

Worker A/B and the strong reviewer can use `run_command` for commands whose lifecycle matters. Built-in Copilot shell remains available for short bounded inspection; agents are instructed not to background a managed command.

`run_command` uses the existing Convergent shell permission policy before any process starts. In `workspace` mode normal workspace-contained commands are approved according to the same rules as built-in shell, while risky commands still require/receive the configured permission decision. The custom tool therefore does not bypass permission mode merely because it is implemented by Convergent.

The managed runtime records a stable command id plus root PID/process identity, streams output progress to the watchdog, keeps bounded stdout/stderr tails, and returns exact final state/exit code. Timeout, explicit session stop/disconnect, or watchdog abort first tries to terminate the managed process tree. POSIX uses a dedicated process group with TERM→KILL confirmation; Windows uses `taskkill /T /F` and verifies the managed root is gone. Commands must remain attached to the managed process tree; deliberately daemonizing/backgrounding away from it is outside the contract and is explicitly discouraged.

A runtime stall is automatically recoverable only when Convergent has both an active managed-command identity and **proven termination evidence**. The stalled SDK session is discarded, a fresh strong recovery coordinator decides whether retry is safe, and any retry creates a fresh Worker/Reviewer session against the preserved workspace. Recovery attempts are bounded per role. Ordinary inactivity without an active managed command, or any unproven termination, remains fail-closed.

## Protecting pre-existing workspace state

Convergent deliberately supports dirty worktrees, so a dirty/untracked path cannot be treated as task output merely because it appears in final `git status`.

Before task work begins, Convergent captures a bounded Git-status baseline and task-start change state. Paths present at task start are protected from cleanup/reversion merely to make status clean. A task may still legitimately edit such a path when the task requires it; the baseline is provenance guidance, not blanket write protection.

The deterministic task-change manifest compares task-start state with current state. Unchanged pre-existing dirty/staged/untracked paths are excluded, while a pre-existing path changed during the task is explicitly marked. Those task-local paths are supplied to whichever peer/reviewer roles are active.

## Resume after interruption or pause

Convergent persists safe workflow checkpoints in VS Code workspace state. Resume with:

```text
@convergent /resume
```

or **Convergent: Resume Last Workflow**.

Resume is boundary-based rather than pretending to restore an opaque in-flight model/tool call:

- interrupted during strong planning: keep the original request and re-run planning;
- deterministic plan already accepted: reuse it rather than adding a planner solely because the run resumed;
- completed architecture assessment: reuse it when the saved task/revision boundary is still valid;
- interrupted between tasks: continue with the next pending task and skip completed tasks;
- generic interruption inside a task: restart only that task against the current workspace;
- `worker_blocked`: re-enter blocker recovery when the saved workspace fingerprint still matches;
- `strong_review_pending`: continue at the saved strong-review boundary;
- `strong_review_findings`: continue from remediation of saved findings;
- `strong_review_blocked`: resume the same required review/recovery boundary.
- proven `worker_runtime_stall` / `reviewer_runtime_stall`: restart only that task from the preserved workspace with fresh sessions; the old managed process tree was already proven terminated.
- unproven runtime-stall checkpoint: `/resume` refuses to start any new agent or command; manually clean up the external process state and start a new workflow instead.

If a fine-grained checkpoint no longer matches the workspace, Convergent discards stale fine-grained state and falls back to restarting only that task, except that an unproven runtime-stall checkpoint never takes that fallback because doing so would violate the termination-proof boundary.

## Headless benchmarks and measured architecture evidence

See [`HEADLESS_BENCHMARKS.md`](HEADLESS_BENCHMARKS.md) and [`ARCHITECTURE_BENCHMARKS.md`](ARCHITECTURE_BENCHMARKS.md) for the harness and architecture-study contracts.

The 0.3 architecture was selected from scenarios that separated topology from model policy and used deterministic external acceptance oracles. The main measured conclusions are:

- unreviewed single-agent modifying work is not a safe general default;
- independent strong review has repeated unique value;
- Worker B adds cost on ordinary work but produced unique semantic/security value on a path-containment boundary, supporting high-risk-only peer activation;
- always-on strong planning was expensive on cohesive tasks without showing corresponding unique value;
- deterministic invariants such as credential provenance and report/validation integrity belong in code, not in additional permanent agents.

A representative plannerless Scenario02 run completed as Luna Worker A → Terra reviewer in **12 model calls, 6.198468 AI credits, and 30.858s**, versus **14 calls, 10.805286 credits, and 52.179s** for the prior equivalent persistent-planner path. The final plannerless Scenario04 recovery run still activated the strong recovery coordinator on demand and completed the high-risk assurance path successfully.

## Trajectory audit

By default Convergent writes a rotating local audit under the extension global-storage directory while keeping normal Chat/Output surfaces compact.

Each run contains:

```text
audit/<run>/
├── manifest.json
├── events.jsonl
├── summary.json
└── analysis.md
```

The audit records session role/model/reasoning configuration, prompts according to audit level, assistant/tool events, managed-command lifecycle metadata, input/output/reasoning/cache usage, context/compaction data, pass/review boundaries, blocker/runtime recovery, steering, and repeated tool signatures. Managed-command progress audit records metadata/byte counts rather than duplicating raw streamed output chunks.

`convergent.audit.level=metadata` keeps event structure and hashes source-bearing payloads. `full` retains bounded local prompt/message/tool content and may contain repository source or command output.

Retention is controlled by `convergent.audit.maxRuns`, `convergent.audit.maxSizeMB`, and `convergent.audit.maxAgeDays`. Use **Convergent: Open Last Trajectory Audit** or **Convergent: Reveal Last Trajectory Audit Folder** to inspect the latest run.

## Soft limits and task checkpoint commits

`convergent.maxWorkerPasses` bounds peer-convergence tranches when a peer is active (high-risk/full and trivial escalation behavior). Normal standard work does not activate Worker B merely to consume this tranche.

`convergent.maxReviewerCycles` bounds strong-review/remediation cycles. Fast asks sooner before spending additional cycles; Auto/Thorough use their configured/profile tranches.

`convergent.maxAiCredits` is an optional soft run budget; `0` disables it. Durable Copilot usage checkpoints can lag live token growth, so this is a safe-boundary control rather than a precise real-time hard cap.

Optional task checkpoint commits can be enabled with:

```json
{
  "convergent.taskCommits": "safe"
}
```

Safe mode creates a checkpoint commit after an accepted modifying task only when that task began with a clean worktree. The default is `off`.


### Multi-root VS Code workspaces

Convergent supports VS Code multi-root workspaces. The active editor folder is the primary agent working directory, while every opened workspace folder is part of the deterministic Convergent scope. Agents may inspect and modify any required opened Git workspace folder; combined fingerprints, task-change evidence, managed-command cwd selection, permissions, review findings, resume identity, and safe task commits cover the full root set. The primary folder keeps Copilot's native edit/create/apply-patch tools; writes to another opened folder use Convergent's bounded `workspace_edit` tool so cross-root mutation does not depend on Copilot CLI working-directory behavior. Every opened folder in scope must be a Git worktree.
