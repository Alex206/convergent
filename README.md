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
  ├─ standard  → persistent A ↔ B until both approve the same revision
  │               → persistent strong reviewer
  └─ high_risk → same full workflow with higher supported reasoning effort
```

Every run has a plan, but planning is proportionate: a simple request can be a one-task plan. Worker A, Worker B, and the strong reviewer keep independent persistent contexts for the lifetime of one implementation task. A and B also receive each other's explicit structured reports so their technical positions can challenge each other instead of communicating only through changed files. Task-local contexts are discarded when the task completes.

## Current MVP

- Native VS Code Copilot Chat entry point: `@convergent`
- Persistent, strong, read-only coordinator that owns requirements understanding, clarification, task decomposition, acceptance criteria, and route/risk classification
- Coordinator can inspect files and run non-mutating repository/shell commands such as `git status` and `git diff`
- Deterministic request preflight catches obvious references to a missing prompt/task and asks the user for the actual objective before spending a coordinator turn
- Coordinator instructions explicitly treat repository instructions/profiles/manifests as constraints, never as a substitute user objective
- Per-task adaptive routes: `read_only`, `trivial`, `standard`, and `high_risk`
- Engine-enforced minimums: `trivial` is reserved for clearly documentation/comment/text-only changes; executable code/tests/scripts are at least `standard`; high-risk semantics force `high_risk`
- Lightweight fast path: A implements, B reviews once, and any B modification automatically escalates to the full standard workflow
- Fresh persistent Worker A, Worker B, and strong-reviewer sessions for each implementation task
- Structured coordinator plan and structured worker/reviewer verdicts via application-owned Copilot SDK tools, with defensive normalization and semantic validation at the tool boundary
- Serialized `<report_pass>` / `<report_review>` assistant output is narrowly recovered when a model emits the structured report as text instead of invoking the custom tool
- Worker reports reserve `findings` for unresolved actionable issues; CLEAN/CHANGED reports with findings are rejected and retried instead of crashing convergence
- Worker verdicts are reconciled against authoritative workspace fingerprints: attributable worker writes can correct a mistaken CLEAN to CHANGED, while unexplained workspace changes still fail closed
- A/B adversarial review/fix loop with explicit peer-report exchange
- Full-workflow convergence requires A and B to approve the exact same workspace revision; a valid `CHANGED` pass approves the revision that worker just produced, while `CLEAN` approves the unchanged current revision
- Persistent strong reviewer remembers its earlier findings during remediation cycles
- Strong-review findings feed back into A/B and must converge again before re-review
- Revision-scoped validation evidence is carried from A/B to the strong reviewer so checks are not rerun mechanically
- Adaptive reasoning effort (`low`, `medium`, `high`) when the selected Copilot model advertises support
- Runtime model discovery with `strong`, `planner`, `cheap-a`, `cheap-b`, risk-adaptive worker policies, and exact model selection
- Worker model capability is resolved after each task is classified: cheap for trivial/low-risk work, economical capable models for standard work, and a stronger implementation tier for high-risk work; Worker B diversifies when possible
- Role-specific Copilot tool allow-lists so coordinator/reviewer do not inherit editing tools and workers do not inherit the full Copilot CLI toolbox
- Workers use purpose-built `apply_patch`, `edit`, and `create` tools for file-content changes; shell-based content editing is blocked
- Validation guidance avoids transient working-tree pollution, optional unrequested extras, and redundant re-reading/re-running after a successful validation
- Event-driven tool and agent inactivity watchdogs; routine heartbeats stay in the Output channel while Chat surfaces meaningful long-running-tool status and user decisions
- Long healthy agent turns are not killed by a fixed wall-clock `sendAndWait` deadline; watchdogs react to lack of progress instead
- Safe workflow checkpoints support `@convergent /resume` and **Convergent: Resume Last Workflow** after interruption, pause, or stop
- Interrupted planning retains the original request; completed tasks are skipped; strong-review findings/pending-review states can resume directly when the workspace fingerprint still matches
- Review/pass limits are soft decision points: continue for more iterations or pause with the resume checkpoint preserved
- Optional `convergent.maxAiCredits` budget prompts at safe workflow boundaries instead of terminating the run automatically
- Optional `convergent.taskCommits=safe` creates accepted task-boundary commits only for tasks that started from a clean worktree
- Live chat status for route/risk, selected models/effort, pass duration, escalation, and usage
- AI usage tracking from Copilot token/usage events and durable nano-AIU checkpoints
- **Show usage**, **Show diagnostics**, **Show agent log**, **Stop workflow**, **Resume workflow**, and **Source Control** chat/command actions
- Native VS Code clarification UI for coordinator `ask_user` requests
- Workspace-aware permission handling and explicit prompts for risky commands
- Detailed agent/tool/usage trace in the **Convergent** output channel, including each role's configured tool allow-list

## Requirements

- VS Code with GitHub Copilot Chat available
- Node.js 22.12+; Node.js 24 LTS is recommended for development
- A Git workspace (Convergent uses Git state to establish exact convergence)
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

## Resume after interruption or pause

Convergent persists safe workflow checkpoints in VS Code workspace state. Resume with:

```text
@convergent /resume
```

or **Convergent: Resume Last Workflow**.

Resume is deliberately boundary-based rather than pretending to restore an opaque in-flight model/tool call:

- interrupted during coordinator planning: keep the original request and re-run planning;
- interrupted between tasks: continue with the next pending task and skip completed tasks;
- generic interruption inside a task: restart only that task with fresh task-local sessions against the current workspace;
- `strong_review_pending`: continue directly with the saved next strong-review cycle when the workspace fingerprint still matches;
- `strong_review_findings`: continue directly with remediation of the saved findings when the workspace fingerprint still matches.

If a fine-grained checkpoint no longer matches the workspace, Convergent does not trust stale review state and falls back to restarting only that task.

## Adaptive routing

The strong coordinator classifies every task, but the JavaScript engine validates the result. The default `convergent.routingMode` is `adaptive`.

| Route | Intended use | Enforced workflow |
| --- | --- | --- |
| `read_only` | Inspection/explanation; no writes required. May still be conceptually complex. | Strong coordinator only |
| `trivial` | Clearly low-risk docs/comment/text/wording change | A implement → B review; B changes → escalate |
| `standard` | Executable source, scripts, tests, build/CI/configuration, normal feature/bugfix/code change | A/B same-revision convergence → strong review |
| `high_risk` | Security/auth, concurrency, migrations, destructive/production-release/architectural changes | Full workflow with higher supported reasoning effort |

Set `convergent.routingMode` to `full` to force every modifying task through at least the standard full-review workflow.

## Model selection and reasoning effort

Convergent discovers models from `client.listModels()` at runtime. This is important for enterprise installations where model availability is controlled by policy. Worker models are selected only after the coordinator has classified the task so route/risk can influence capability.

| Role | Selector | Default behavior |
| --- | --- | --- |
| Coordinator | `strong` | Strong model; medium reasoning when supported. Persistent for the complete user request. |
| Worker A | `adaptive` | `trivial/low` → cheap tier; `standard` → economical capable tier; `high_risk`/high risk → stronger implementation tier |
| Worker B | `adaptive-diverse` | Scale with the same route/risk, but prefer a different capable model from Worker A when one is available |
| Strong reviewer | `strong` | Strong model; low effort for low-risk standard tasks, medium for normal standard tasks, high for high-risk tasks when supported |

Current adaptive tier preferences are deterministic and availability-aware. For example, a high-risk Worker A prefers GPT-5.6 Terra or Claude Sonnet 5 when available, then strong GPT-5.6 Sol/GPT-5.5/full GPT-5.4-class options; Worker B first seeks a different capable model such as GPT-5.4 mini. Standard Worker A prefers GPT-5.6 Luna or GPT-5.4 mini before falling back to less preferred options. Trivial/low-risk work retains the existing cheap-worker behavior.

Exact model ids/names and explicit presets are overrides. For example, setting `convergent.models.workerA` to `claude-haiku-4.5`, `gpt-5.5`, `cheap-a`, or `strong` disables adaptive promotion for Worker A. `cheap-b` retains its low-cost diversity behavior. This makes `adaptive` a policy, while explicit configuration remains predictable.

The lower-cost `planner` selector remains available as an explicit configuration option, but it is not the default: planning and task slicing are treated as high-leverage decisions where an underpowered model can incorrectly simplify a complex request.

`convergent.reasoningMode=adaptive` applies role/route-driven effort only when the selected model advertises the requested reasoning-effort capability. Set it to `model-default` to leave reasoning effort untouched.

## Soft limits and task checkpoint commits

`convergent.maxWorkerPasses` (default `8`) and `convergent.maxReviewerCycles` (default `3`) are soft iteration tranches. Reaching one no longer makes the workflow fail solely because the counter was exhausted. At a safe decision boundary Convergent asks whether to continue for one or three more passes/cycles, or pause and resume later.

`convergent.maxAiCredits` is an optional soft run budget; `0` (the default) disables it. When the latest durable Copilot usage reaches the configured budget at a safe workflow boundary, Convergent asks whether to add another budget tranche, continue without a budget, or pause. Durable credit checkpoints can lag live token growth, so this is not an exact real-time hard cap.

Optional task checkpoint commits can be enabled with:

```json
{
  "convergent.taskCommits": "safe"
}
```

In `safe` mode, Convergent creates a checkpoint commit after an accepted modifying task only when that task began with a clean worktree. The next task therefore sees the previous accepted task as `HEAD`, making normal Git diffs task-local. If the task starts dirty, automatic commit is skipped rather than sweeping pre-existing changes into history. The default is `off`.

## Tool policy

Convergent deliberately does not expose every Copilot CLI tool to every role. This both limits authority and reduces the tool-definition context paid on each model roundtrip.

- Coordinator: `view`, `glob`, `rg`/`grep`, the platform shell for read-only diagnostics, `ask_user`, and `report_plan`.
- Worker A/B: the same repository inspection/search primitives, the platform shell for validation/cleanup, `apply_patch`, `edit`, `create`, and `report_pass`.
- Strong reviewer: read/search/diagnostic shell plus `report_review`; no file editing and no `ask_user`.

`apply_patch` is the Copilot CLI patch-oriented editing primitive and is preferred when a coherent change can be applied efficiently as a patch, including related edits across files. `edit` remains useful for precise replacements and `create` for new files. Workers are prevented from falling back to PowerShell/bash file-content editing such as `Set-Content`, redirection, `sed -i`, or shell-level patch commands.

Convergent intentionally does not expose Copilot subagent/delegation tools to A/B/reviewer because agent scheduling belongs to the deterministic Convergent engine. The configured tool list for each live session is written to the **Convergent** output channel for troubleshooting.

## Stall detection and cancellation

Copilot SDK `sendAndWait(..., timeout)` treats `timeout` as a wall-clock deadline for waiting until `session.idle`. It does not mean “cancel only after this much inactivity.” Convergent therefore does not use that SDK timeout as its stall detector: a healthy agentic turn may run for many minutes while continuously producing tool/usage/message events.

Instead, Convergent uses two event-driven watchdogs:

- `convergent.toolStallTimeoutSeconds` (default 120s): while a tool is running, this measures time since the latest tool progress/partial-result event;
- `convergent.agentInactivityTimeoutSeconds` (default 180s): when no tool is running, this measures time since any observed agent/tool/usage activity.

Routine heartbeat diagnostics remain in the **Convergent** Output channel instead of accumulating immutable `working · last activity ...` rows in Chat. Long-running tools can still surface periodic meaningful status.

When an interactive tool-stall threshold is reached, Convergent shows the tool and, where the SDK event provides it, a useful command/path detail, then asks whether to **Continue 5 min**, **Continue 15 min**, or **Abort agent turn**. Agent inactivity similarly asks whether to continue waiting or abort. Non-interactive/test frontends retain a bounded steering/cancellation fallback.

The older `convergent.agentTurnTimeoutSeconds` setting is deprecated because its name suggested a total turn limit. If it was explicitly configured and the new inactivity setting is not, Convergent uses the legacy value as the inactivity threshold during migration.

The SDK currently does not expose a documented `kill(toolCallId)` for built-in PowerShell/bash calls, so `Abort agent turn` cannot yet guarantee independent subprocess termination. A Convergent-owned command runner with process-tree ownership is the planned path to command-only stop/retry.

## Validation evidence

Each worker report can include concise checks actually performed against its final revision. Convergent keeps this evidence only while the exact workspace revision remains current; any repository change discards evidence from the previous revision.

When A/B converge, the strong reviewer receives the accumulated evidence for that exact revision. Evidence is not treated as proof, but low-risk reviewers are instructed not to rerun already-passed checks mechanically unless a concrete concern justifies independent verification. Medium/high-risk review can still rerun critical checks as needed.

Validation should avoid polluting the working tree. For example, Python validation should use `-B` or `PYTHONDONTWRITEBYTECODE=1` where practical so `__pycache__` is not created merely by Convergent's own checks.

## Usage and AI credits

Convergent records per-session model calls, input/output tokens, turn count, active duration, context usage, and Copilot durable `totalNanoAiu` checkpoints. The chat shows a running compact usage line after meaningful turns and a per-agent table at the end. **Convergent: Show AI Usage** shows the latest snapshot while a run is active or after it finishes.

The displayed AI-credit figure is an approximate presentation derived as `totalNanoAiu / 1e9`, following the Copilot SDK usage documentation's nano-unit example. Durable credit checkpoints can lag live token growth during a turn; GitHub Copilot billing remains the source of truth for actual billable credits/cost.

## Convergence invariant

For the `standard` and `high_risk` routes, convergence means both workers approve the exact same workspace revision fingerprint.

A worker's final workspace fingerprint is authoritative for whether the pass changed the workspace. The normal report contract remains:

```text
CLEAN   → worker changed nothing and approves the current revision
CHANGED → worker made a substantive change, left no unresolved findings,
          and approves the resulting revision it just produced
```

If a worker mistakenly reports `CLEAN` after successful Convergent-observed `edit`, `apply_patch`, or `create` calls changed the fingerprint, Convergent reconciles that verdict to `CHANGED` instead of discarding the whole run. If the fingerprint changed without attributable worker write-tool activity, Convergent still fails closed because the change could have come from the user, another process, or validation pollution. Conversely, a `CHANGED` report whose final fingerprint is identical is normalized to `CLEAN`.

A worker therefore does not need a second pass merely to approve its own unchanged result. For example:

```text
A: CHANGED R1   → A approves R1
B: CLEAN   R1   → B approves R1
=============================
worker convergence
```

If B instead changes `R1` to `R2`, every approval and validation result for `R1` is discarded. B's valid `CHANGED` pass approves `R2`, and A must independently approve `R2`:

```text
A: CHANGED R1   → A approves R1
B: CHANGED R2   → discard all R1 approvals/evidence; B approves R2
A: CLEAN   R2   → A approves R2
=============================
worker convergence
```

Any later repository write repeats the same invalidation rule. `BLOCKED` never approves a revision.

Worker `findings` means unresolved actionable issues only. Issues found and fixed, disagreements with the peer, and other non-actionable observations belong in the structured summary. This keeps `CLEAN` and `CHANGED` unambiguous while still preserving the peer's technical position.

The revision fingerprint covers `HEAD`, staged changes, unstaged changes, and untracked file contents.

The `trivial` route intentionally uses a lighter guarantee: Worker B is the independent approval after A's implementation. If B changes anything, that lightweight approval is invalid and the task escalates to standard convergence plus strong review.

## Packaging

`npm run package` uses the project's pinned `@vscode/vsce`. A `.vscodeignore` excludes development/test/editor/CI metadata and old VSIX files, and npm install-script permissions for the reviewed native/packaging dependencies are explicit.

The VSIX remains large because the Copilot SDK carries its compatible runtime/platform payload; current CI measures roughly 176 MB compressed. That runtime is intentionally not excluded blindly. VSCE's remaining file-count/bundle warning is tracked as a packaging optimization problem rather than suppressed as if solved.

## Safety

The coordinator and strong reviewer are read-only. They can inspect repository state and run diagnostic commands, but Convergent blocks obvious shell mutations and also checks the workspace revision before/after their turns as a second line of defense.

The default `workspace` permission mode automatically approves ordinary reads, workspace writes for implementation workers, and non-risky shell commands so the workflow can operate without constant prompts. Writes outside the workspace are denied. Risky commands such as `git push`, `git reset --hard`, and destructive recursive deletion require explicit approval.

Set `convergent.permissionMode` to `ask` to require approval for shell commands and writes.

## Status

This is still an MVP. Useful next increments include a Convergent-owned cancellable command runner, a dedicated mutable agent/task dashboard, richer diff/finding navigation, empirical model-quality/cost scoring to refine the adaptive tiers, profile-based specialized teams, and a CLI frontend over the same orchestrator core. Optional use of the VS Code-selected chat model for coordination and explicit user routing hints are tracked separately as future improvements.
