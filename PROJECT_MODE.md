# Convergent Project Mode

Project Mode is an experimental layer above the normal Convergent task workflow. It must not weaken or replace the existing VS Code/Copilot Chat path for normal engineering work.

## Product split

```text
Normal Convergent
  VS Code / Copilot Chat
  -> request planning/classification
  -> task execution
  -> validation/review/remediation/recovery

Project Mode
  project intake / requirements / use cases
  -> approved project plan and milestones
  -> autonomous milestone execution
  -> existing Convergent task workflow per executable task
  -> milestone stakeholder gates
  -> feedback / replanning / continuation
```

The existing task engine remains the execution substrate. Project Mode coordinates it; it does not duplicate Worker A, peer/reviewer, command runtime, validation, or task-level recovery.

## Core requirements

Project Mode should support the interaction model of an external software-development partner:

1. Accept a project brief rather than requiring a fully specified implementation task.
2. Investigate repository/product context before asking questions that can be answered independently.
3. Clarify material stakeholder requirements, use cases, constraints, non-goals, acceptance criteria, and unresolved product/design choices.
4. Batch questions where possible instead of interrupting repeatedly.
5. Produce an explicit project plan with milestones, deliverables, dependencies, acceptance criteria, risks, and budget allocation.
6. Require stakeholder approval before starting major implementation against a newly proposed project plan.
7. Execute an approved milestone autonomously through normal Convergent task workflows.
8. Do not ask for approval after every internal task.
9. Interrupt only for a material stakeholder decision, unresolved external prerequisite, significant scope/budget change, safety/policy boundary, or explicit milestone review gate.
10. At milestone boundaries, present the usable product state, validation evidence, known limitations, consumed/remaining budget, and proposed next milestone.
11. Accept stakeholder feedback, record decisions, revise remaining work, and continue without losing accepted history.
12. Finish only when project-level acceptance criteria are satisfied or the stakeholder explicitly ends/changes the project.

## Non-goals

- Do not replace the normal `@convergent` VS Code workflow.
- Do not make VS Code Chat the Project Mode persistence layer.
- Do not restore opaque in-flight model calls after crashes.
- Do not introduce a second implementation/reviewer engine.
- Do not make AG-UI or CopilotKit part of Convergent Core semantics.
- Do not require a web frontend for the first usable Project Mode slice.
- Do not treat a model-generated plan as authoritative state without deterministic validation/versioning.

## Architecture

```text
                         frontends
                +-----------------------+
                | VS Code | Web | CLI   |
                +----------+------------+
                           |
                    frontend events
                           |
                 +---------v----------+
                 | Project Orchestrator|
                 +---------+----------+
                           |
              durable project state/events
                           |
                 +---------v----------+
                 | Existing Convergent |
                 | task workflow       |
                 +---------+----------+
                           |
          Worker / review / validation / recovery
```

Convergent Core should expose frontend-neutral project commands/events. An AG-UI adapter can be added at the boundary later; the core domain model must not depend on AG-UI.

## Durable project model

The first stable domain model should contain, at minimum:

```text
Project
  id
  revision
  status
  objective
  stakeholders[]
  useCases[]
  requirements[]
  nonGoals[]
  constraints[]
  assumptions[]
  openQuestions[]
  decisions[]
  risks[]
  budget
    total
    spent
    reserved
    remaining
  milestones[]
    id
    objective
    deliverables[]
    dependencies[]
    acceptanceCriteria[]
    budget
    status
    tasks[]
```

Requirements, decisions, plans, and milestones need stable ids and revisions so later feedback can be reconciled instead of silently rewriting project history.

## Event model

Meaningful state transitions should be represented as durable events, for example:

```text
PROJECT_CREATED
DISCOVERY_STARTED
QUESTION_RAISED
QUESTION_ANSWERED
REQUIREMENT_ADDED
REQUIREMENT_REVISED
DECISION_RECORDED
PLAN_PROPOSED
PLAN_APPROVED
MILESTONE_STARTED
TASK_STARTED
TASK_ACCEPTED
TASK_BLOCKED
MILESTONE_READY_FOR_REVIEW
MILESTONE_ACCEPTED
FEEDBACK_RECEIVED
PLAN_REVISED
PROJECT_COMPLETED
PROJECT_PAUSED
```

The event contract is frontend-neutral. VS Code, AG-UI/CopilotKit, CLI, or a future service frontend should map to the same project commands/events.

## Recovery invariant

Project recovery extends the existing Convergent principle: restore deterministic workflow state, not opaque model state.

After restart or ownership loss:

1. Load the latest durable project snapshot/event sequence.
2. Reconcile repository and relevant external state with the checkpoint.
3. Preserve already accepted milestones/tasks when their deterministic evidence still matches.
4. Resume from the nearest safe project/task boundary.
5. Re-run only work whose completion cannot be proven.
6. Never start replacement execution while a previous owned command/process may still be active; existing controlled-command termination/recovery remains authoritative.

A future remote service should add a lease/owner mechanism so only one executor can mutate a project at a time.

## Budget semantics

Project budget is a ledger, not only `maxAiCredits`.

- `maxAiCredits` remains a run-level safety boundary.
- Project Mode tracks planned, reserved, spent, and remaining budget across runs/milestones.
- Small reallocations within an approved policy may be automatic.
- A material forecast overrun or insufficient remaining project budget becomes a stakeholder gate.
- Usage/accounting uncertainty must fail conservatively; a soft provider usage signal must not be presented as an exact financial guarantee.

## Stakeholder gates

Project Mode should normally stop for the stakeholder only at explicit semantic gates:

- unresolved material requirement/product decision;
- approval of a new or materially revised project plan;
- significant scope/budget/architecture deviation;
- external prerequisite that cannot be recovered autonomously;
- milestone review/demonstration;
- final project acceptance.

Implementation-task review/remediation remains internal unless one of these conditions is reached.

## Delivery sequence

### P0 - Domain contracts and recovery model

No model inference required.

- immutable/project-versioned domain schema;
- state machine and legal transitions;
- event schema;
- budget ledger semantics;
- stakeholder-gate semantics;
- snapshot + replay/reconciliation contract;
- deterministic tests for invalid transitions, duplicate events, replay, crash boundaries, and budget accounting.

### P1 - Project discovery and planning

- `/project` or equivalent entry point in VS Code;
- strong Project Coordinator, read-only during discovery;
- requirements/use-case/open-question/decision model;
- batched stakeholder clarification;
- proposed milestone plan and budget;
- explicit plan approval gate;
- no autonomous implementation before approval.

### P2 - Milestone execution through existing task engine

- translate one approved milestone into executable Convergent tasks;
- invoke the existing task workflow unchanged as far as practical;
- persist task/milestone progress independently of VS Code chat history;
- resume after interruption using deterministic task/project state;
- milestone completes only after all required task acceptance boundaries are proven.

### P3 - Feedback, replanning, and budget governance

- milestone review summary/demo contract;
- stakeholder feedback and decision recording;
- impact analysis against remaining requirements/milestones;
- revised-plan approval only when material scope changes;
- budget forecasting, reserves, threshold-based escalation.

### P4 - Frontend-neutral event/API boundary

- stable project command/event API;
- VS Code adapter uses that API rather than private project-engine calls;
- AG-UI adapter implementation and compatibility tests;
- no requirement for CopilotKit in core.

### P5 - Persistent headless service / web frontend

- repository/worktree lifecycle;
- single-owner lease and takeover/reconciliation;
- remote pause/resume/steering;
- AG-UI + optional CopilotKit web UX;
- notifications for stakeholder gates;
- GitHub issue/PR-driven project entry points where useful.

## First implementation rule

Do not begin with UI. Begin with P0 domain/state/recovery contracts and deterministic tests. If those contracts are correct, VS Code Chat can be the first frontend and AG-UI can be added without changing project semantics later.
