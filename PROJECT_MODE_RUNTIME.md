# Project Mode runtime and session model

This document fixes two runtime decisions before Project Mode gains model inference or remote execution.

## Project Manager sessions are episodic

A Project Mode project may live for days or weeks. No correctness property may depend on keeping one GitHub Copilot model session alive for that lifetime.

The Project Manager is a strong reasoning role used for bounded episodes such as:

- initial discovery and stakeholder clarification;
- initial project/milestone planning;
- material replanning after stakeholder feedback;
- milestone review preparation;
- project-level recovery analysis when deterministic reconciliation needs reasoning.

A session may remain open within one useful episode, but it is disposable at every durable project boundary. A later session receives a deterministic handoff built from authoritative ProjectState plus current repository/external evidence.

The handoff contains the project objective/revision/status, stakeholders, use cases, current requirements, recorded decisions, unanswered questions, current/approved plan revisions, milestone state, budget state, execution target, current stakeholder gate and expected next semantic action.

The handoff deliberately excludes hidden chain-of-thought, transient model scratch state and reliance on the previous session transcript. Persistent knowledge belongs in versioned project state/events and repository/project artifacts.

## Actor policy

Initial Project Mode adds the minimum new roles:

- **Project Manager** — strong model selector, episodic session, proposal authority. Owns requirements discovery, stakeholder clarification, project/milestone planning, replanning and milestone summaries.
- **Project Architect** — strong model selector, fresh/ephemeral and conditional. Activated only for architecture-significant project or milestone decisions. Advisory only.
- **Existing Convergent task engine** — unchanged task-scoped coordinator, Worker A/B, reviewer architecture, validation/remediation and task recovery.

Do not add permanent project critics, planners or review panels until measured evidence shows a missing capability.

Models are selectors rather than hard-coded identities. `strong` should resolve through the normal Convergent model policy; Project Mode must not make durable project state depend on one named model being available indefinitely.

## Session handoff invariant

At every durable boundary, another compatible Project Manager must be able to continue with:

1. the latest durable ProjectState/event stream;
2. a deterministic Project Manager handoff derived from that state;
3. reconciled current repository/workspace state;
4. reconciled external execution/CI state when relevant.

If those inputs are insufficient, Project Mode must open a stakeholder/recovery gate rather than fabricate missing history.

## Remote execution policy

The intended company remote execution path is the existing **GARM + Portainer** infrastructure. Project Mode core must not require GCP Cloud Run, Cloud Workstations or another external execution service.

The first execution-target contract supports:

- `local` — the developer's local/workspace execution environment;
- `garm-portainer` — a company-managed remote/container execution environment selected by runner labels/capabilities and Portainer endpoint/pool metadata.

The durable target stores only non-secret routing/configuration information such as labels, pool, endpoint id, image and isolation level. Credentials remain under existing company/Convergent secret and authorization mechanisms.

A later execution manager may provision or acquire a GARM/Portainer worker per project, milestone or task. The Project Orchestrator should reason about execution capabilities and exact workspace identity, not about a specific machine/container lifetime.

## Recovery across container loss

Project state must never live only in the execution container.

On worker/container loss:

1. determine whether the prior executor/managed commands can still be active;
2. use existing controlled-command/process termination evidence when applicable;
3. load durable project state;
4. acquire/provision a replacement GARM/Portainer execution target;
5. restore/reconcile the repository/workspace to the last proven project/task boundary;
6. resume only work whose completion cannot already be proven.

A future persistent service must add project executor leases so only one executor can mutate a project at a time.

## Browser code / preview

A future web frontend may expose a code workspace or product preview hosted inside the company-managed execution environment. This is a frontend/runtime capability, not part of ProjectState semantics.

Project Mode should therefore emit stable artifacts/events such as `workspace_available`, `preview_available`, or milestone review metadata, while the GARM/Portainer integration decides how those endpoints are provisioned and exposed according to company policy.
