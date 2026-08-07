# Convergent

Convergent is a VS Code extension that turns GitHub Copilot into a deterministic multi-agent implementation workflow:

```text
User
  ↓
Coordinator (persistent for the whole request)
  ↓ plan
Task N
  ├─ Worker A (persistent for Task N)
  ├─ Worker B (persistent for Task N)
  │    A/B alternate review + fix until both approve the exact same revision
  └─ Strong reviewer (persistent for Task N)
       findings → A/B remediation loop → same reviewer re-checks
       clean    → next task
```

The orchestrator owns sequencing. LLMs do not decide which agent runs next, whether convergence is reached, or whether the strong review can be skipped.

## Current MVP

- Native VS Code Copilot Chat entry point: `@convergent`
- Persistent coordinator session for the whole user request
- Fresh persistent Worker A, Worker B, and strong-reviewer sessions for each implementation task
- Structured coordinator plan and structured worker/reviewer verdicts via application-owned Copilot SDK tools
- A/B adversarial review/fix loop
- Convergence only when A and B both return `CLEAN` against the exact same workspace revision fingerprint
- Persistent strong reviewer remembers its earlier findings during remediation cycles
- Strong-review findings feed back into A/B and must converge again before re-review
- Configurable max worker passes and reviewer cycles
- Runtime model discovery with `strong`, `cheap-a`, and `cheap-b` presets plus exact model selection
- Native VS Code clarification UI for Copilot `ask_user` requests
- Workspace-aware permission handling and explicit prompts for risky commands
- Detailed agent/tool trace in the **Convergent** output channel

## Requirements

- VS Code with GitHub Copilot Chat available
- Node.js supported by the extension host
- A Git workspace (the MVP uses Git state to establish exact convergence)
- A GitHub Copilot entitlement that can use the Copilot SDK

The Node.js Copilot SDK bundles the compatible Copilot CLI runtime. Authentication uses the SDK's normal Copilot authentication chain. If no token or existing credentials are available, authenticate Copilot CLI once (for example with `copilot login`); the SDK can reuse the stored OAuth credentials.

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

## Model selection

Convergent resolves models from `client.listModels()` at runtime. This is important for enterprise installations where model availability is controlled by policy.

Defaults:

| Role | Selector | Behavior |
| --- | --- | --- |
| Coordinator | `strong` | Prefer the strongest known coding/reasoning model available |
| Worker A | `cheap-a` | Prefer Claude Haiku-class, then other low-cost models |
| Worker B | `cheap-b` | Prefer Gemini Flash-class, then a different low-cost fallback |
| Strong reviewer | `strong` | Prefer the strongest known model available |

Each setting also accepts an exact Copilot model id or display name. If a configured model is unavailable, Convergent falls back to Copilot `auto` instead of failing the workflow.

## Convergence invariant

A previous `CLEAN` verdict becomes invalid as soon as any agent changes the repository.

For revision `R`:

```text
A reviews R → CLEAN
B reviews R → CLEAN
====================
worker convergence
```

If B changes `R` to `R2`, A's earlier approval of `R` is discarded and both agents must approve `R2`.

The revision fingerprint covers `HEAD`, staged changes, unstaged changes, and untracked file contents.

## Safety

The default `workspace` permission mode automatically approves ordinary reads, workspace writes, and non-risky shell commands so the implementation loop can operate without constant prompts. Writes outside the workspace are denied. Risky commands such as `git push`, `git reset --hard`, and destructive recursive deletion require explicit approval.

Set `convergent.permissionMode` to `ask` to require approval for shell commands and writes.

## Status

This is the initial MVP. Useful next increments include resumable workflow state after VS Code reload, a dedicated agent/task tree view, richer diffs and finding navigation, configurable review strategies, and a CLI frontend over the same orchestrator core.
