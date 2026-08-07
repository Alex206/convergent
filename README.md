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
- Per-task adaptive routes: `read_only`, `trivial`, `standard`, and `high_risk`
- Engine-enforced minimums: `trivial` is reserved for clearly documentation/comment/text-only changes; executable code/tests/scripts are at least `standard`; high-risk semantics force `high_risk`
- Lightweight fast path: A implements, B reviews once, and any B modification automatically escalates to the full standard workflow
- Fresh persistent Worker A, Worker B, and strong-reviewer sessions for each implementation task
- Structured coordinator plan and structured worker/reviewer verdicts via application-owned Copilot SDK tools, with defensive normalization and semantic validation at the tool boundary
- Worker reports reserve `findings` for unresolved actionable issues; CLEAN/CHANGED reports with findings are rejected and retried instead of crashing convergence
- A/B adversarial review/fix loop with explicit peer-report exchange
- Full-workflow convergence requires A and B to approve the exact same workspace revision; a valid `CHANGED` pass approves the revision that worker just produced, while `CLEAN` approves the unchanged current revision
- Persistent strong reviewer remembers its earlier findings during remediation cycles
- Strong-review findings feed back into A/B and must converge again before re-review
- Revision-scoped validation evidence is carried from A/B to the strong reviewer so checks are not rerun mechanically
- Adaptive reasoning effort (`low`, `medium`, `high`) when the selected Copilot model advertises support
- Runtime model discovery with `strong`, `planner`, `cheap-a`, and `cheap-b` presets plus exact model selection
- Worker A prefers GPT-5.6 Luna when available for low-cost tool-heavy implementation passes; Worker B prefers a different cheap model
- Role-specific Copilot tool allow-lists so coordinator/reviewer do not inherit editing tools and workers do not inherit the full Copilot CLI toolbox
- Workers use purpose-built `apply_patch`, `edit`, and `create` tools for file-content changes; shell-based content editing is blocked
- Validation guidance avoids transient working-tree pollution, optional unrequested extras, and redundant re-reading/re-running after a successful validation
- Live chat status for route/risk, selected models/effort, pass duration, escalation, and usage
- AI usage tracking from Copilot token/usage events and durable nano-AIU checkpoints
- **Show usage**, **Show agent log**, **Stop workflow**, and **Source Control** chat buttons
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
```

Press `F5` in VS Code to launch an Extension Development Host, open a Git repository, then use:

```text
@convergent Implement <your task>
```

Or run **Convergent: Start Workflow** from the command palette.

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

Convergent resolves models from `client.listModels()` at runtime. This is important for enterprise installations where model availability is controlled by policy.

| Role | Selector | Default behavior |
| --- | --- | --- |
| Coordinator | `strong` | Strong model; medium reasoning when supported. Persistent for the complete user request. |
| Worker A | `cheap-a` | Prefer GPT-5.6 Luna when available, then another low-cost worker model |
| Worker B | `cheap-b` | Prefer a different low-cost model from A |
| Strong reviewer | `strong` | Strong model; low effort for low-risk standard tasks, medium for normal standard tasks, high for high-risk tasks when supported |

The lower-cost `planner` selector remains available as an explicit configuration option, but it is not the default: planning and task slicing are treated as high-leverage decisions where an underpowered model can incorrectly simplify a complex request.

`convergent.reasoningMode=adaptive` applies role/route-driven effort only when the selected model advertises the requested reasoning-effort capability. Set it to `model-default` to leave reasoning effort untouched.

## Tool policy

Convergent deliberately does not expose every Copilot CLI tool to every role. This both limits authority and reduces the tool-definition context paid on each model roundtrip.

- Coordinator: `view`, `glob`, `rg`/`grep`, the platform shell for read-only diagnostics, `ask_user`, and `report_plan`.
- Worker A/B: the same repository inspection/search primitives, the platform shell for validation/cleanup, `apply_patch`, `edit`, `create`, and `report_pass`.
- Strong reviewer: read/search/diagnostic shell plus `report_review`; no file editing and no `ask_user`.

`apply_patch` is the Copilot CLI patch-oriented editing primitive and is preferred when a coherent change can be applied efficiently as a patch, including related edits across files. `edit` remains useful for precise replacements and `create` for new files. Workers are prevented from falling back to PowerShell/bash file-content editing such as `Set-Content`, redirection, `sed -i`, or shell-level patch commands.

Convergent intentionally does not expose Copilot subagent/delegation tools to A/B/reviewer because agent scheduling belongs to the deterministic Convergent engine. The configured tool list for each live session is written to the **Convergent** output channel for troubleshooting.

## Validation evidence

Each worker report can include concise checks actually performed against its final revision. Convergent keeps this evidence only while the exact workspace revision remains current; any repository change discards evidence from the previous revision.

When A/B converge, the strong reviewer receives the accumulated evidence for that exact revision. Evidence is not treated as proof, but low-risk reviewers are instructed not to rerun already-passed checks mechanically unless a concrete concern justifies independent verification. Medium/high-risk review can still rerun critical checks as needed.

Validation should avoid polluting the working tree. For example, Python validation should use `-B` or `PYTHONDONTWRITEBYTECODE=1` where practical so `__pycache__` is not created merely by Convergent's own checks.

## Usage and AI credits

Convergent records per-session model calls, input/output tokens, turn count, active duration, context usage, and Copilot durable `totalNanoAiu` checkpoints. The chat shows a running compact usage line after meaningful turns and a per-agent table at the end. **Convergent: Show AI Usage** shows the latest snapshot while a run is active or after it finishes.

The displayed AI-credit figure is an approximate presentation derived as `totalNanoAiu / 1e9`, following the Copilot SDK usage documentation's nano-unit example. GitHub Copilot billing remains the source of truth for actual billable credits/cost.

## Convergence invariant

For the `standard` and `high_risk` routes, convergence means both workers approve the exact same workspace revision fingerprint.

A valid worker pass approves its final revision in either of two ways:

```text
CLEAN   → worker changed nothing and approves the current revision
CHANGED → worker made a substantive change, left no unresolved findings,
          and approves the resulting revision it just produced
```

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

## Safety

The coordinator and strong reviewer are read-only. They can inspect repository state and run diagnostic commands, but Convergent blocks obvious shell mutations and also checks the workspace revision before/after their turns as a second line of defense.

The default `workspace` permission mode automatically approves ordinary reads, workspace writes for implementation workers, and non-risky shell commands so the workflow can operate without constant prompts. Writes outside the workspace are denied. Risky commands such as `git push`, `git reset --hard`, and destructive recursive deletion require explicit approval.

Set `convergent.permissionMode` to `ask` to require approval for shell commands and writes.

## Status

This is still an MVP. Useful next increments include resumable workflow state after VS Code reload, a dedicated mutable agent/task dashboard, richer diff/finding navigation, empirical model-quality/cost scoring from Convergent runs, and a CLI frontend over the same orchestrator core. Optional use of the VS Code-selected chat model for coordination and explicit user routing hints are tracked separately as future improvements.
