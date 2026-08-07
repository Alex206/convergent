# Convergent

Convergent is a VS Code extension that turns GitHub Copilot into an adaptive, deterministic multi-agent workflow. The coordinator understands and classifies the task; application code decides what workflow is allowed to run.

```text
User
  ↓
Coordinator (persistent for the whole request, read-only)
  ↓ classify + plan
Task N
  ├─ read_only → coordinator result only
  ├─ trivial   → Worker A implements → Worker B reviews
  │               B changes anything → escalate to standard
  ├─ standard  → persistent A ↔ B until both approve the same revision
  │               → persistent strong reviewer
  └─ high_risk → same full workflow with higher supported reasoning effort
```

Worker A, Worker B, and the strong reviewer keep independent persistent contexts for the lifetime of one implementation task. A and B also receive each other's explicit structured reports so their technical positions can challenge each other instead of communicating only through changed files. Task-local contexts are discarded when the task completes.

## Current MVP

- Native VS Code Copilot Chat entry point: `@convergent`
- Persistent, read-only coordinator that can inspect files and run non-mutating repository/shell commands such as `git status` and `git diff`
- Per-task adaptive routes: `read_only`, `trivial`, `standard`, and `high_risk`
- Engine-enforced minimums: medium-risk tasks cannot use `trivial`; high-risk modifying tasks are forced to `high_risk`
- Lightweight fast path: A implements, B reviews once, and any B modification automatically escalates to the full standard workflow
- Fresh persistent Worker A, Worker B, and strong-reviewer sessions for each implementation task
- Structured coordinator plan and structured worker/reviewer verdicts via application-owned Copilot SDK tools
- A/B adversarial review/fix loop with explicit peer-report exchange
- Full-workflow convergence only when A and B both return `CLEAN` against the exact same workspace revision fingerprint
- Persistent strong reviewer remembers its earlier findings during remediation cycles
- Strong-review findings feed back into A/B and must converge again before re-review
- Adaptive reasoning effort (`low`, `medium`, `high`) when the selected Copilot model advertises support
- Runtime model discovery with `strong`, `cheap-a`, and `cheap-b` presets plus exact model selection
- Worker B prefers a different cheap model from Worker A when available
- Live chat status for route/risk, selected models/effort, pass duration, escalation, and usage
- AI usage tracking from Copilot token/usage events and durable nano-AIU checkpoints
- **Show usage**, **Show agent log**, **Stop workflow**, and **Source Control** chat buttons
- Native VS Code clarification UI for Copilot `ask_user` requests
- Workspace-aware permission handling and explicit prompts for risky commands
- Detailed agent/tool/usage trace in the **Convergent** output channel

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

The coordinator classifies every task, but the TypeScript engine validates the result. The default `convergent.routingMode` is `adaptive`.

| Route | Intended use | Enforced workflow |
| --- | --- | --- |
| `read_only` | Inspection/explanation; no writes required | Coordinator only |
| `trivial` | Low-risk localized docs/metadata/mechanical change | A implement → B review; B changes → escalate |
| `standard` | Normal feature/bugfix/code change | A/B same-revision convergence → strong review |
| `high_risk` | Security/auth, concurrency, migrations, destructive/release/build/architectural changes | Full workflow with higher supported reasoning effort |

Set `convergent.routingMode` to `full` to force every modifying task through at least the standard full-review workflow.

## Model selection and reasoning effort

Convergent resolves models from `client.listModels()` at runtime. This is important for enterprise installations where model availability is controlled by policy.

| Role | Selector | Default behavior |
| --- | --- | --- |
| Coordinator | `strong` | Strong model; medium reasoning when supported |
| Worker A | `cheap-a` | Prefer a low-cost worker model |
| Worker B | `cheap-b` | Prefer a different low-cost model from A |
| Strong reviewer | `strong` | Strong model; medium/high reasoning according to route when supported |

`convergent.reasoningMode=adaptive` applies route-driven effort only when the selected model advertises the requested reasoning-effort capability. Set it to `model-default` to leave reasoning effort untouched.

## Usage and AI credits

Convergent records per-session model calls, input/output tokens, turn count, active duration, context usage, and Copilot durable `totalNanoAiu` checkpoints. The chat shows a running compact usage line after meaningful turns and a per-agent table at the end. **Convergent: Show AI Usage** shows the latest snapshot while a run is active or after it finishes.

The displayed AI-credit figure is derived as `totalNanoAiu / 1e9`, following the Copilot SDK usage documentation's nano-unit convention. GitHub Copilot billing remains the source of truth for actual billable credits/cost.

## Convergence invariant

For the `standard` and `high_risk` routes, a previous `CLEAN` verdict becomes invalid as soon as any agent changes the repository.

```text
A reviews revision R → CLEAN
B reviews revision R → CLEAN
============================
worker convergence
```

If B changes `R` to `R2`, A's earlier approval of `R` is discarded and both agents must approve `R2`.

The revision fingerprint covers `HEAD`, staged changes, unstaged changes, and untracked file contents.

The `trivial` route intentionally uses a lighter guarantee: Worker B is the independent approval after A's implementation. If B changes anything, that lightweight approval is invalid and the task escalates to standard convergence plus strong review.

## Safety

The coordinator and strong reviewer are read-only. They can inspect repository state and run diagnostic commands, but Convergent checks the workspace revision before/after their turns and rejects any unexpected mutation.

The default `workspace` permission mode automatically approves ordinary reads, workspace writes for implementation workers, and non-risky shell commands so the workflow can operate without constant prompts. Writes outside the workspace are denied. Risky commands such as `git push`, `git reset --hard`, and destructive recursive deletion require explicit approval.

Set `convergent.permissionMode` to `ask` to require approval for shell commands and writes.

## Status

This is still an MVP. Useful next increments include resumable workflow state after VS Code reload, a dedicated mutable agent/task dashboard, richer diff/finding navigation, empirical model-quality/cost scoring from Convergent runs, and a CLI frontend over the same orchestrator core.
