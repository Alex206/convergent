# Convergent

Convergent is a VS Code extension that turns GitHub Copilot into an adaptive, deterministic multi-agent workflow. A persistent strong coordinator understands the request, clarifies material ambiguity, slices it into proportionate tasks, defines acceptance criteria, and classifies each task; application code decides what workflow is allowed to run.

```text
User
  ↓
Strong coordinator (persistent for the whole request, read-only)
  ↓ understand + clarify + classify + plan
Task N
  ├─ read_only → coordinator result only
  ├─ trivial   → Worker A implements → Worker B reviews
  │               B changes anything → escalate to standard
  ├─ standard  → persistent A ↔ B until both approve the same workspace fingerprint
  │               → persistent strong reviewer
  └─ high_risk → same full workflow with higher supported reasoning effort
```

Every run has a plan, but planning is proportionate: a simple request can be a one-task plan. Worker A, Worker B, and the strong reviewer keep independent persistent contexts for the lifetime of one implementation task. A and B also receive each other's explicit structured reports so their technical positions can challenge each other instead of communicating only through changed files. Task-local contexts are discarded when the task completes.

## Current development capabilities

- Native VS Code Copilot Chat entry point: `@convergent`
- Persistent, strong, read-only coordinator that owns requirements understanding, clarification, task decomposition, acceptance criteria, and route/risk classification
- Per-task adaptive routes: `read_only`, `trivial`, `standard`, and `high_risk`, with deterministic minimum-route enforcement
- Selectable execution flows: `@convergent /fast`, `/auto`, and `/thorough`
- Risk/flow-aware adaptive Worker A and diversified Worker B model selection; exact configured model selectors remain hard overrides
- Exact workspace-state convergence using an opaque fingerprint over Git HEAD plus staged, unstaged, and untracked content
- Structured coordinator, worker, reviewer, and recovery-coordinator reports owned by the Convergent application
- A/B adversarial review/fix convergence followed by a required strong-review gate
- Strong-review first cycle collects all independently discoverable findings in its selected scope; later cycles focus on previous findings and the remediation delta
- Revision-scoped validation evidence is carried between agents so successful checks need not be rerun mechanically
- `BLOCKED` is a recoverable state: a fresh strong read-only recovery coordinator can retry, hand a worker blocker to the peer, ask the operator a free-text question, or pause safely
- Manual **Convergent: Steer Active Agent** support using Copilot immediate steering
- Event-driven Chat status: meaningful agent messages/tool starts/usage are visible while routine heartbeat spam stays in the Output channel
- Event-driven inactivity/tool-stall watchdogs instead of treating the SDK `sendAndWait` wall-clock timeout as liveness
- Safe workflow checkpoints with `@convergent /resume`
- Soft worker/reviewer/AI-credit decision limits rather than abrupt counter failures
- Optional `convergent.taskCommits=safe` task-boundary checkpoint commits
- Rotating local trajectory audit with per-LLM-call token/cache/context/tool/review telemetry
- Task-start Git-status baselines protect dirty/staged/untracked user workspace state from being mistaken for task output

## Requirements

- VS Code with GitHub Copilot Chat available
- Node.js 22.12+; Node.js 24 LTS is recommended for development
- A Git workspace
- A GitHub Copilot entitlement that can use the Copilot SDK

The Node.js Copilot SDK bundles the compatible Copilot CLI runtime. Authentication uses the SDK's normal Copilot authentication chain.

## Development

```bash
npm install
npm test
npm run check
npm run package
```

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

| Flow | Intent | Initial behavior |
| --- | --- | --- |
| `fast` | Reach an accepted reviewed result quickly | One bounded coordinator inspection for a concrete request; focused workers/reviewer; max 3 A/B passes before asking; initial strong review plus one automatic remediation/delta re-review before asking again |
| `auto` | Balanced default | Adaptive route/risk model selection and configured soft tranches |
| `thorough` | Favor assurance over speed | Broader first review and at least the normal full convergence/review tranches |

Fast does **not** mean “always use the cheapest model” or “always use the strongest model.” Low-risk standard work remains on the economical capable tier; medium-risk Fast work may promote Worker A when a stronger implementation pass is likely to avoid multiple weak-model iterations. High-risk work retains the high-risk tier. Exact user-configured model ids/names/presets override this policy.

Fast also changes agent guidance to reduce round trips: use one focused inspection, batch related edits/creates with `apply_patch` where practical, reuse peer-provided file/check information, and do not mechanically rerun a successful peer check against the same current workspace fingerprint.

## Protecting pre-existing workspace state

Convergent deliberately supports dirty worktrees, so a dirty/untracked path cannot be treated as task output merely because it appears in the final `git status`.

Before the first Worker A/B/reviewer session for each task, Convergent captures a bounded Git status baseline. The same baseline is supplied to both workers and the strong reviewer. Paths present at task start are explicitly identified as pre-existing user workspace state. Agents are instructed not to remove, revert, overwrite, stage, or report those paths as out-of-scope task defects merely to make the workspace clean. The prompt includes at most 50 status entries; additional entries are summarized to bound context growth.

The baseline is provenance guidance, not blanket write protection: a task may legitimately need to edit a pre-existing dirty file. The task and acceptance criteria remain authoritative.

## Reviewer behavior

The first strong-review cycle is a bounded finding-collection sweep. Finding one valid defect is not a reason to stop: the reviewer should finish the selected review scope and report all independently discoverable actionable findings together.

Later review cycles first verify previous findings, then inspect the remediation delta and directly affected callers/tests/interfaces. They should not re-run the complete original review merely to search for more unrelated findings unless the remediation materially expands scope/architecture or concrete evidence/risk warrants it.

For Fast low-risk tasks, validation evidence already produced by A/B on the exact reviewed workspace fingerprint should normally be reused rather than mechanically repeating the same successful test command.

## Blocker recovery and steering

A worker or strong-reviewer `BLOCKED` verdict is not approval and does not automatically terminate the workflow. Convergent checkpoints the state and invokes a fresh strong read-only recovery coordinator. Its final action is structured:

- worker blocker: `peer`, `retry`, `ask_user`, or `pause`;
- reviewer blocker: `retry`, `ask_user`, or `pause` because the required reviewer gate cannot be bypassed.

If `ask_user` is selected, Convergent opens a native free-text question. The answer goes back to the same recovery coordinator, which must then choose the final deterministic action. Recovery/operator guidance is injected once into the selected agent's next normal turn.

While an agent is working, **Convergent: Steer Active Agent** can inject an operator message into the active Copilot turn without restarting the task.

## Resume after interruption or pause

Convergent persists safe workflow checkpoints in VS Code workspace state. Resume with:

```text
@convergent /resume
```

or **Convergent: Resume Last Workflow**.

Resume is boundary-based rather than pretending to restore an opaque in-flight model/tool call:

- interrupted during coordinator planning: keep the original request and re-run planning;
- interrupted between tasks: continue with the next pending task and skip completed tasks;
- generic interruption inside a task: restart only that task against the current workspace;
- `worker_blocked`: re-enter blocker recovery when the saved workspace fingerprint still matches;
- `strong_review_pending`: continue at the saved strong-review boundary;
- `strong_review_findings`: continue from remediation of the saved findings;
- `strong_review_blocked`: resume the same required review cycle/recovery boundary.

If a fine-grained checkpoint no longer matches the workspace, Convergent discards stale fine-grained state and falls back to restarting only that task.

## Adaptive routing

The strong coordinator classifies every task, but the JavaScript engine validates the result. The default `convergent.routingMode` is `adaptive`.

| Route | Intended use | Enforced workflow |
| --- | --- | --- |
| `read_only` | Inspection/explanation; no writes required | Strong coordinator only |
| `trivial` | Clearly low-risk docs/comment/text/wording change | A implement → B review; B changes → escalate |
| `standard` | Executable source, scripts, tests, build/CI/configuration, normal feature/bugfix/code change | A/B same-fingerprint convergence → strong review |
| `high_risk` | Security/auth, concurrency, migrations, destructive/production-release/architectural changes | Full workflow with higher supported reasoning effort |

Set `convergent.routingMode` to `full` to force every modifying task through at least the standard full-review workflow.

## Model selection and reasoning effort

Convergent discovers models from `client.listModels()` at runtime. Worker models are selected only after the coordinator has classified the task so route/risk/flow can influence capability.

| Role | Selector | Default behavior |
| --- | --- | --- |
| Coordinator | `strong` | Strong model; medium reasoning when supported; persistent for the complete request |
| Worker A | `adaptive` | Low-risk standard → economical capable tier; medium-risk Fast may promote; high-risk → stronger implementation tier |
| Worker B | `adaptive-diverse` | Scale with route/risk while preferring a different capable model from Worker A |
| Strong reviewer | `strong` | Strong model; effort scales with task risk when supported |

Exact model ids/names and explicit presets are overrides. `convergent.reasoningMode=adaptive` applies role/route-driven effort only when the selected model advertises the requested reasoning-effort capability. Set it to `model-default` to leave reasoning effort untouched.

## Trajectory audit

By default Convergent writes a rotating local audit under the extension global-storage directory while keeping the normal Chat/Output surfaces compact.

Each run contains:

```text
audit/<run>/
├── manifest.json
├── events.jsonl
├── summary.json
└── analysis.md
```

The audit can record:

- Convergent-added system prompt and outbound prompt sizes/hashes/content according to audit level;
- session role/model/reasoning configuration;
- assistant turn and tool events;
- input/output/reasoning/cache-read/cache-write usage;
- context-window size/message-count snapshots and compaction events;
- worker pass/reviewer cycle boundaries;
- review findings first seen in later cycles;
- repeated identical tool-argument signatures;
- blocker recovery and operator steering events.

`convergent.audit.level=metadata` keeps event structure and hashes source-bearing payloads. `full` retains bounded local prompt/message/tool content and may therefore contain repository source or command output.

Retention is controlled by `convergent.audit.maxRuns`, `convergent.audit.maxSizeMB`, and `convergent.audit.maxAgeDays`. Use **Convergent: Open Last Trajectory Audit** or **Convergent: Reveal Last Trajectory Audit Folder** to inspect the latest run.

## Soft limits and task checkpoint commits

`convergent.maxWorkerPasses` and `convergent.maxReviewerCycles` are soft iteration tranches. Fast caps the first A/B tranche at 3 and allows the initial strong review plus one automatic remediation/delta re-review before asking whether to spend more. Auto/Thorough use their profile/configured tranches.

`convergent.maxAiCredits` is an optional soft run budget; `0` disables it. Durable Copilot usage checkpoints can lag live token growth, so this is a safe-boundary control rather than a precise real-time hard cap.

Optional task checkpoint commits can be enabled with:

```json
{
  "convergent.taskCommits": "safe"
}
```

Safe mode creates a checkpoint commit after an accepted modifying task only when that task began with a clean worktree. The default is `off`.

## Tool policy

Convergent deliberately limits role tool surfaces to reduce authority and tool-definition context:

- Coordinator: read/search, diagnostic shell, `ask_user`, `report_plan`.
- Recovery coordinator: read/search, diagnostic shell, `report_recovery`.
- Worker A/B: read/search, validation shell, `apply_patch`, `edit`, `create`, `report_pass`.
- Strong reviewer: read/search, diagnostic shell, `report_review`; no edits and no direct `ask_user`.

Workers are prevented from using shell redirection/`Set-Content`/`sed -i`/similar commands for file-content edits; purpose-built file tools are required. Shell cleanup remains available for generated artifacts, with prompt/baseline rules protecting pre-existing workspace state.

## Stall detection and cancellation

Convergent bypasses the Copilot SDK `sendAndWait()` wall-clock timeout as the liveness mechanism. A healthy agentic turn may run for many minutes while producing tool/message/usage events.

Instead it uses:

- `convergent.toolStallTimeoutSeconds`: no-progress time while a tool is active;
- `convergent.agentInactivityTimeoutSeconds`: no observed agent/tool/usage activity when no tool is active.

Routine heartbeat diagnostics remain in the **Convergent** Output channel. When a threshold is reached, the UI asks whether to continue waiting or abort the current agent turn.

The SDK still does not expose a documented command-only `kill(toolCallId)` for built-in shell calls; a Convergent-owned subprocess runner remains future work.

## Usage and AI credits

Convergent records per-session model calls, input/output/reasoning/cache tokens, turn count, active duration, context usage, and durable Copilot nano-AIU checkpoints. Chat shows compact running usage and a per-agent table at completion; the trajectory audit provides the per-LLM-call detail needed for optimization.

Displayed AI credits are derived as `totalNanoAiu / 1e9`; durable checkpoints can lag live usage and GitHub billing remains authoritative.

## Convergence invariant

For `standard` and `high_risk`, convergence means A and B explicitly approve the exact same workspace fingerprint.

```text
CLEAN   → worker made no repository change and approves current fingerprint
CHANGED → worker made a substantive change, left no unresolved finding,
          and approves the resulting fingerprint
BLOCKED → no approval
```

A valid `CHANGED` pass approves its resulting fingerprint immediately; a worker does not need to review its own unchanged output again. If a peer changes the workspace, all approvals/evidence for the previous fingerprint are invalidated. A `BLOCKED` pass never counts as approval even if that pass changed the workspace; after recovery the normal A/B approval invariant still applies.

## Current dev.9 validation

The latest code/package validation passed 116/116 tests, `npm run check`, and real VSIX packaging. PR #4 remains draft for live VS Code trajectory testing before merge/release.
