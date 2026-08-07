# Convergent

Convergent is a VS Code extension that turns GitHub Copilot into an adaptive, deterministic multi-agent coding workflow with a persistent strong coordinator, independent implementation/review agents, exact-revision convergence, strong review, resumable checkpoints, and visible workflow state.

## Current development build

`0.2.0-dev.4`

## Workflow

```text
User request
  ↓
Strong coordinator (persistent, read-only)
  ↓ understand + clarify + classify + plan
Task N
  ├─ read_only → coordinator result only
  ├─ trivial   → Worker A implements → Worker B reviews
  │               B changes anything → escalate to standard
  ├─ standard  → persistent A ↔ B until both approve the same revision
  │               → persistent strong reviewer
  └─ high_risk → same full workflow with higher supported reasoning effort
```

Worker A, Worker B, and the strong reviewer use fresh persistent contexts for each implementation task. A/B exchange structured reports and Convergent, rather than the models, owns the state machine and convergence rules.

## Development

```bash
npm install
npm test
npm run check
npm run package
```

Use `@convergent <request>` in Copilot Chat, or run **Convergent: Start Workflow**.

## Resume

Convergent persists safe checkpoints in VS Code workspace state. Resume using:

```text
@convergent /resume
```

or **Convergent: Resume Last Workflow**.

Current resume boundaries include:

- planning: retain the original request and restart coordinator planning;
- completed task: skip it and continue with the next task;
- generic interruption inside a task: restart only that task against the current workspace;
- `strong_review_pending`: resume directly at the next strong-review cycle when the workspace fingerprint still matches;
- `strong_review_findings`: resume directly with remediation of the saved findings when the fingerprint still matches.

If a fine-grained checkpoint no longer matches the current workspace, Convergent discards that stale task state and safely falls back to restarting only the current task.

## Model selection

Convergent discovers Copilot models at runtime. Defaults are:

| Role | Default |
| --- | --- |
| Coordinator | `strong` |
| Worker A | `adaptive` |
| Worker B | `adaptive-diverse` |
| Strong reviewer | `strong` |

Adaptive worker selection happens after route/risk classification. Trivial/low-risk work stays cheap, standard work favors economical capable models, and high-risk work promotes Worker A to a stronger implementation tier. Worker B prefers a different capable model when available. Exact model ids/names and explicit presets are hard overrides.

## Convergence

For `standard` and `high_risk`, both workers must approve the exact same workspace revision fingerprint. A valid `CHANGED` pass approves the resulting revision; a valid `CLEAN` pass approves an unchanged revision. Any later write invalidates older approvals and revision-scoped validation evidence.

The fingerprint covers `HEAD`, staged changes, unstaged changes, and untracked file contents.

If a worker mistakenly reports `CLEAN` after attributable `edit`, `apply_patch`, or `create` activity changed the fingerprint, Convergent reconciles the verdict to `CHANGED`. An unexplained workspace change still fails closed.

## Long-running tools and status

Convergent bypasses the Copilot SDK 1.0.8 `sendAndWait()` wall-clock timeout and waits on SDK events instead. Healthy active turns can therefore run beyond 60/180 seconds.

Routine `working · last activity ...` heartbeats are written to the **Convergent** Output channel instead of being repeatedly appended to Chat. Chat surfaces meaningful phase changes, usage checkpoints, pass/review results, and periodic status for genuinely long-running tools.

`convergent.toolStallTimeoutSeconds` is a no-progress threshold, not a maximum command duration. If a built-in tool is quiet past the threshold, Convergent shows the tool and, when the SDK provides useful arguments, the command/path, and asks whether to:

- **Continue 5 min**;
- **Continue 15 min**;
- **Abort agent turn**.

`convergent.agentInactivityTimeoutSeconds` similarly asks whether to continue waiting or abort when no agent/tool activity is observed.

The Copilot SDK does not currently expose a documented `kill(toolCallId)` for built-in PowerShell/bash tools, so abort currently cancels the in-flight agent turn rather than guaranteeing independent subprocess termination. A Convergent-owned command runner with PID/process-tree control is the planned path to command-only cancellation/retry.

## Soft limits

Iteration and budget limits are decision points rather than automatic workflow failures.

- `convergent.maxWorkerPasses` (default `8`): A/B convergence tranche. At the limit Convergent asks to continue for 1 or 3 more passes, or pause.
- `convergent.maxReviewerCycles` (default `3`): strong-review tranche. If findings remain, Convergent asks to continue for 1 or 3 more cycles, or pause. Remaining findings have already been checkpointed.
- `convergent.maxAiCredits` (default `0`, disabled): optional soft run budget. At a safe workflow boundary after reported usage crosses the budget, Convergent asks to add another budget tranche, continue without a budget, or pause.

A user-selected pause is presented as a normal resumable state, not as an error. Resume later with `@convergent /resume`.

Copilot credit checkpoints can lag live token growth, so an AI-credit budget is necessarily enforced at safe boundaries using the latest reported durable usage rather than as an exact real-time hard cap.

## Optional task checkpoint commits

Set:

```json
{
  "convergent.taskCommits": "safe"
}
```

to create a Git checkpoint commit after each accepted modifying task **only if that task started with a clean worktree**. The next task then starts with the previous accepted task as `HEAD`, which makes normal Git diffs much more task-local and can reduce cumulative-change exploration by later agents.

The default is `off`. If a task begins with an existing dirty worktree, safe mode skips the automatic commit rather than sweeping pre-existing changes into history. Commit failures do not discard accepted changes; they remain in the worktree.

## Tool and permission policy

The coordinator and strong reviewer are read-only. Workers use repository read/search tools, validation shell commands, and purpose-built `apply_patch`, `edit`, and `create` tools. Shell-based file-content editing is blocked for workers. Obvious shell mutations are denied for read-only roles, and workspace fingerprints before/after read-only turns provide a second defense.

`convergent.permissionMode=workspace` automatically approves normal workspace operations while still prompting for risky commands. `ask` prompts more aggressively.

## Usage

Convergent records per-session models, token usage, turns, active duration, context information, and Copilot durable nano-AIU checkpoints. **Convergent: Show AI Usage** shows the latest snapshot.

The displayed AI-credit number is derived from Copilot nano-AIU usage (`nano-AIU / 1e9`). Durable credit reporting may lag token growth during an active turn; GitHub billing remains the source of truth.

## Packaging

`npm run package` uses the pinned `@vscode/vsce`. `.vscodeignore` excludes development/test/editor/CI metadata and prior VSIX files, and reviewed native/packaging install scripts are explicitly allowed.

The VSIX is still large (currently about 176 MB in CI) because the Copilot SDK carries its compatible runtime/platform payload. That runtime is intentionally not excluded blindly. VSCE's file-count/bundle warning remains a measured packaging optimization item.

## Status

Convergent is still pre-0.2 development. Current priorities include a Convergent-owned cancellable command runner, richer task/pass resume boundaries, better task dashboards/diff navigation, empirical model cost/quality routing, and profile/team topologies such as architect → implementer → test engineer → reviewer.
