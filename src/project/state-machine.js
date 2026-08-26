'use strict';

const {
  PROJECT_STATE_VERSION,
  PROJECT_STATUSES,
  MILESTONE_STATUSES,
  createProjectState,
  normalizeAmount,
  normalizeExecutionTarget,
  stringList,
  text,
} = require('./model');
const { applyBudgetEvent } = require('./budget');
const { normalizeProjectEvent, projectEventFingerprint } = require('./events');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireStatus(state, allowed, eventType) {
  if (!allowed.includes(state.status)) {
    throw new Error(`${eventType} is not valid while project status is '${state.status}'.`);
  }
}

function requireNoGate(state, eventType) {
  if (state.stakeholderGate) throw new Error(`${eventType} cannot proceed while stakeholder gate '${state.stakeholderGate.kind}' is open.`);
}

function itemById(items, id, kind) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown ${kind} '${id}'.`);
  return item;
}

function ensureUniqueIds(items, kind) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`Duplicate ${kind} id '${item.id}'.`);
    seen.add(item.id);
  }
}

function normalizeUseCase(data) {
  return {
    id: text(data.id, 'use case id'),
    title: text(data.title, 'use case title'),
    description: text(data.description, 'use case description'),
    actors: stringList(data.actors),
    acceptanceCriteria: stringList(data.acceptanceCriteria),
    revision: 1,
  };
}

function normalizeRequirement(data) {
  return {
    id: text(data.id, 'requirement id'),
    text: text(data.text, 'requirement text'),
    acceptanceCriteria: stringList(data.acceptanceCriteria),
    priority: String(data.priority ?? 'must').trim().toLowerCase(),
    revision: 1,
    status: 'active',
  };
}

function normalizeTask(value = {}) {
  return {
    id: text(value.id, 'task id'),
    title: text(value.title ?? value.id, 'task title'),
    description: text(value.description ?? value.title ?? value.id, 'task description'),
    acceptanceCriteria: stringList(value.acceptanceCriteria),
    status: String(value.status ?? 'planned').trim().toLowerCase(),
  };
}

function normalizeMilestone(value = {}, previous = null) {
  const milestone = {
    id: text(value.id, 'milestone id'),
    objective: text(value.objective, 'milestone objective'),
    deliverables: stringList(value.deliverables),
    dependencies: stringList(value.dependencies),
    acceptanceCriteria: stringList(value.acceptanceCriteria),
    budgetAllocation: normalizeAmount(value.budgetAllocation ?? 0, 'milestone budgetAllocation'),
    tasks: Array.isArray(value.tasks) ? value.tasks.map(normalizeTask) : [],
    status: previous?.status ?? MILESTONE_STATUSES.PLANNED,
  };
  if (!milestone.acceptanceCriteria.length) {
    throw new Error(`Milestone '${milestone.id}' requires acceptance criteria.`);
  }
  ensureUniqueIds(milestone.tasks, `task in milestone '${milestone.id}'`);
  return milestone;
}

function comparableMilestone(milestone) {
  const { status, ...rest } = milestone;
  return rest;
}

function validateMilestoneGraph(milestones) {
  ensureUniqueIds(milestones, 'milestone');
  const byId = new Map(milestones.map((milestone) => [milestone.id, milestone]));
  for (const milestone of milestones) {
    for (const dependency of milestone.dependencies) {
      if (dependency === milestone.id) throw new Error(`Milestone '${milestone.id}' cannot depend on itself.`);
      if (!byId.has(dependency)) throw new Error(`Milestone '${milestone.id}' depends on unknown milestone '${dependency}'.`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Milestone dependency cycle includes '${id}'.`);
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const milestone of milestones) visit(milestone.id);
}

function normalizePlan(state, data) {
  const planRevision = Number(data.planRevision);
  if (!Number.isInteger(planRevision) || planRevision <= state.planRevision) {
    throw new Error(`planRevision must be an integer greater than ${state.planRevision}.`);
  }
  if (!Array.isArray(data.milestones) || !data.milestones.length) {
    throw new Error('A project plan requires at least one milestone.');
  }

  const previousById = new Map(state.milestones.map((milestone) => [milestone.id, milestone]));
  const milestones = data.milestones.map((value) => normalizeMilestone(value, previousById.get(String(value.id ?? '').trim())));
  validateMilestoneGraph(milestones);

  for (const previous of state.milestones.filter((milestone) => milestone.status === MILESTONE_STATUSES.ACCEPTED)) {
    const current = milestones.find((milestone) => milestone.id === previous.id);
    if (!current) throw new Error(`Accepted milestone '${previous.id}' cannot be removed by replanning.`);
    if (JSON.stringify(comparableMilestone(current)) !== JSON.stringify(comparableMilestone(previous))) {
      throw new Error(`Accepted milestone '${previous.id}' cannot be rewritten by replanning.`);
    }
  }

  const allocation = milestones.reduce((sum, milestone) => sum + milestone.budgetAllocation, 0);
  if (allocation > state.budget.total + 1e-9) {
    throw new Error(`Milestone allocations ${allocation} exceed project budget ${state.budget.total}.`);
  }

  return { planRevision, milestones };
}

function registerEvent(state, event, fingerprint) {
  state.appliedEventFingerprints[event.id] = fingerprint;
  state.revision += 1;
  state.lastEvent = {
    id: event.id,
    type: event.type,
    ...(event.at ? { at: event.at } : {}),
  };
  return state;
}

function applyProjectEvent(currentState, rawEvent) {
  const event = normalizeProjectEvent(rawEvent);
  const fingerprint = projectEventFingerprint(event);

  if (!currentState) {
    if (event.type !== 'PROJECT_CREATED') throw new Error('The first project event must be PROJECT_CREATED.');
    const state = createProjectState(event.data);
    return registerEvent(state, event, fingerprint);
  }

  if (currentState.schemaVersion !== PROJECT_STATE_VERSION) {
    throw new Error(`Unsupported project state schema version '${currentState.schemaVersion}'.`);
  }
  const existingFingerprint = currentState.appliedEventFingerprints?.[event.id];
  if (existingFingerprint) {
    if (existingFingerprint !== fingerprint) throw new Error(`Event id '${event.id}' was reused with different content.`);
    return clone(currentState);
  }

  if (event.data.projectId && String(event.data.projectId) !== currentState.id) {
    throw new Error(`Event projectId '${event.data.projectId}' does not match project '${currentState.id}'.`);
  }

  const state = clone(currentState);

  switch (event.type) {
    case 'PROJECT_CREATED':
      throw new Error('PROJECT_CREATED may only be the first event.');

    case 'DISCOVERY_STARTED':
      requireStatus(state, [PROJECT_STATUSES.DRAFT], event.type);
      state.status = PROJECT_STATUSES.DISCOVERY;
      break;

    case 'USE_CASE_ADDED': {
      requireStatus(state, [PROJECT_STATUSES.DISCOVERY, PROJECT_STATUSES.REPLANNING], event.type);
      const useCase = normalizeUseCase(event.data);
      if (state.useCases.some((item) => item.id === useCase.id)) throw new Error(`Duplicate use case id '${useCase.id}'.`);
      state.useCases.push(useCase);
      break;
    }

    case 'REQUIREMENT_ADDED': {
      requireStatus(state, [PROJECT_STATUSES.DISCOVERY, PROJECT_STATUSES.REPLANNING], event.type);
      const requirement = normalizeRequirement(event.data);
      if (state.requirements.some((item) => item.id === requirement.id)) throw new Error(`Duplicate requirement id '${requirement.id}'.`);
      state.requirements.push(requirement);
      break;
    }

    case 'REQUIREMENT_REVISED': {
      requireStatus(state, [PROJECT_STATUSES.DISCOVERY, PROJECT_STATUSES.REPLANNING], event.type);
      const id = text(event.data.id, 'requirement id');
      const requirement = itemById(state.requirements, id, 'requirement');
      if (event.data.expectedRevision !== undefined && Number(event.data.expectedRevision) !== requirement.revision) {
        throw new Error(`Requirement '${id}' revision conflict: expected ${event.data.expectedRevision}, current ${requirement.revision}.`);
      }
      requirement.text = text(event.data.text, 'requirement text');
      if (event.data.acceptanceCriteria !== undefined) requirement.acceptanceCriteria = stringList(event.data.acceptanceCriteria);
      if (event.data.priority !== undefined) requirement.priority = text(event.data.priority, 'requirement priority').toLowerCase();
      requirement.revision += 1;
      break;
    }

    case 'DECISION_RECORDED': {
      requireStatus(state, [PROJECT_STATUSES.DISCOVERY, PROJECT_STATUSES.REPLANNING, PROJECT_STATUSES.EXECUTING, PROJECT_STATUSES.MILESTONE_REVIEW], event.type);
      const decision = {
        id: text(event.data.id, 'decision id'),
        question: text(event.data.question, 'decision question'),
        decision: text(event.data.decision, 'decision'),
        rationale: String(event.data.rationale ?? '').trim(),
      };
      if (state.decisions.some((item) => item.id === decision.id)) throw new Error(`Duplicate decision id '${decision.id}'.`);
      state.decisions.push(decision);
      break;
    }

    case 'QUESTION_RAISED': {
      requireStatus(state, [PROJECT_STATUSES.DISCOVERY, PROJECT_STATUSES.REPLANNING, PROJECT_STATUSES.EXECUTING, PROJECT_STATUSES.MILESTONE_REVIEW], event.type);
      requireNoGate(state, event.type);
      const question = {
        id: text(event.data.id, 'question id'),
        text: text(event.data.text, 'question text'),
        reason: String(event.data.reason ?? '').trim(),
        status: 'open',
        answer: null,
      };
      if (state.openQuestions.some((item) => item.id === question.id)) throw new Error(`Duplicate question id '${question.id}'.`);
      state.openQuestions.push(question);
      state.stakeholderGate = { kind: 'question', questionId: question.id, resumeStatus: state.status };
      state.status = PROJECT_STATUSES.AWAITING_STAKEHOLDER;
      break;
    }

    case 'QUESTION_ANSWERED': {
      requireStatus(state, [PROJECT_STATUSES.AWAITING_STAKEHOLDER], event.type);
      if (state.stakeholderGate?.kind !== 'question') throw new Error('No stakeholder question is awaiting an answer.');
      const id = text(event.data.id, 'question id');
      if (state.stakeholderGate.questionId !== id) throw new Error(`Question '${id}' is not the active stakeholder gate.`);
      const question = itemById(state.openQuestions, id, 'question');
      question.status = 'answered';
      question.answer = text(event.data.answer, 'question answer');
      state.status = state.stakeholderGate.resumeStatus;
      state.stakeholderGate = null;
      break;
    }

    case 'PLAN_PROPOSED':
    case 'PLAN_REVISED': {
      const expectedStatus = event.type === 'PLAN_PROPOSED' ? PROJECT_STATUSES.DISCOVERY : PROJECT_STATUSES.REPLANNING;
      requireStatus(state, [expectedStatus], event.type);
      requireNoGate(state, event.type);
      if (state.openQuestions.some((question) => question.status === 'open')) {
        throw new Error('Cannot propose a plan while stakeholder questions remain unanswered.');
      }
      const plan = normalizePlan(state, event.data);
      state.planRevision = plan.planRevision;
      state.milestones = plan.milestones;
      state.approvedPlanRevision = null;
      state.stakeholderGate = { kind: 'plan_approval', planRevision: plan.planRevision };
      state.status = PROJECT_STATUSES.AWAITING_PLAN_APPROVAL;
      break;
    }

    case 'PLAN_APPROVED': {
      requireStatus(state, [PROJECT_STATUSES.AWAITING_PLAN_APPROVAL], event.type);
      if (state.stakeholderGate?.kind !== 'plan_approval') throw new Error('No project plan is awaiting approval.');
      const planRevision = Number(event.data.planRevision);
      if (planRevision !== state.planRevision || planRevision !== state.stakeholderGate.planRevision) {
        throw new Error(`Plan approval revision ${planRevision} does not match proposed revision ${state.planRevision}.`);
      }
      state.approvedPlanRevision = planRevision;
      state.stakeholderGate = null;
      state.status = PROJECT_STATUSES.EXECUTING;
      break;
    }

    case 'MILESTONE_STARTED': {
      requireStatus(state, [PROJECT_STATUSES.EXECUTING], event.type);
      requireNoGate(state, event.type);
      if (state.approvedPlanRevision !== state.planRevision) throw new Error('Cannot start a milestone without an approved current plan.');
      if (state.activeMilestoneId) throw new Error(`Milestone '${state.activeMilestoneId}' is already active.`);
      const id = text(event.data.id, 'milestone id');
      const milestone = itemById(state.milestones, id, 'milestone');
      if (milestone.status !== MILESTONE_STATUSES.PLANNED) throw new Error(`Milestone '${id}' is not planned.`);
      for (const dependency of milestone.dependencies) {
        const dependencyMilestone = itemById(state.milestones, dependency, 'milestone dependency');
        if (dependencyMilestone.status !== MILESTONE_STATUSES.ACCEPTED) {
          throw new Error(`Milestone '${id}' cannot start before dependency '${dependency}' is accepted.`);
        }
      }
      milestone.status = MILESTONE_STATUSES.ACTIVE;
      state.activeMilestoneId = id;
      break;
    }

    case 'MILESTONE_READY_FOR_REVIEW': {
      requireStatus(state, [PROJECT_STATUSES.EXECUTING], event.type);
      const id = text(event.data.id, 'milestone id');
      if (state.activeMilestoneId !== id) throw new Error(`Milestone '${id}' is not the active milestone.`);
      const milestone = itemById(state.milestones, id, 'milestone');
      if (milestone.status !== MILESTONE_STATUSES.ACTIVE) throw new Error(`Milestone '${id}' is not active.`);
      milestone.status = MILESTONE_STATUSES.REVIEW;
      state.status = PROJECT_STATUSES.MILESTONE_REVIEW;
      break;
    }

    case 'MILESTONE_ACCEPTED': {
      requireStatus(state, [PROJECT_STATUSES.MILESTONE_REVIEW], event.type);
      const id = text(event.data.id, 'milestone id');
      if (state.activeMilestoneId !== id) throw new Error(`Milestone '${id}' is not the milestone under review.`);
      const milestone = itemById(state.milestones, id, 'milestone');
      if (milestone.status !== MILESTONE_STATUSES.REVIEW) throw new Error(`Milestone '${id}' is not ready for review.`);
      milestone.status = MILESTONE_STATUSES.ACCEPTED;
      state.activeMilestoneId = null;
      state.status = PROJECT_STATUSES.EXECUTING;
      break;
    }

    case 'FEEDBACK_RECEIVED': {
      requireStatus(state, [PROJECT_STATUSES.MILESTONE_REVIEW], event.type);
      const id = text(event.data.milestoneId ?? state.activeMilestoneId, 'milestone id');
      if (state.activeMilestoneId !== id) throw new Error(`Milestone '${id}' is not the milestone under review.`);
      const milestone = itemById(state.milestones, id, 'milestone');
      milestone.status = MILESTONE_STATUSES.ACTIVE;
      state.feedback.push({
        id: text(event.data.id, 'feedback id'),
        milestoneId: id,
        text: text(event.data.text, 'feedback text'),
      });
      state.status = PROJECT_STATUSES.REPLANNING;
      break;
    }

    case 'BUDGET_RESERVED':
    case 'BUDGET_RELEASED':
    case 'BUDGET_SPENT':
      requireStatus(state, Object.values(PROJECT_STATUSES).filter((status) => status !== PROJECT_STATUSES.COMPLETED), event.type);
      state.budget = applyBudgetEvent(state.budget, event);
      break;

    case 'EXECUTION_TARGET_SELECTED': {
      requireStatus(state, [PROJECT_STATUSES.DRAFT, PROJECT_STATUSES.DISCOVERY, PROJECT_STATUSES.AWAITING_PLAN_APPROVAL, PROJECT_STATUSES.EXECUTING, PROJECT_STATUSES.REPLANNING, PROJECT_STATUSES.PAUSED], event.type);
      if (state.activeMilestoneId) throw new Error('Execution target cannot change while a milestone is active.');
      state.executionTarget = normalizeExecutionTarget(event.data.target);
      break;
    }

    case 'PROJECT_PAUSED':
      requireStatus(state, [PROJECT_STATUSES.DRAFT, PROJECT_STATUSES.DISCOVERY, PROJECT_STATUSES.AWAITING_STAKEHOLDER, PROJECT_STATUSES.AWAITING_PLAN_APPROVAL, PROJECT_STATUSES.EXECUTING, PROJECT_STATUSES.MILESTONE_REVIEW, PROJECT_STATUSES.REPLANNING], event.type);
      state.pauseResumeStatus = state.status;
      state.status = PROJECT_STATUSES.PAUSED;
      break;

    case 'PROJECT_RESUMED':
      requireStatus(state, [PROJECT_STATUSES.PAUSED], event.type);
      if (!state.pauseResumeStatus) throw new Error('Paused project has no resumable status.');
      state.status = state.pauseResumeStatus;
      state.pauseResumeStatus = null;
      break;

    case 'PROJECT_COMPLETED':
      requireStatus(state, [PROJECT_STATUSES.EXECUTING], event.type);
      requireNoGate(state, event.type);
      if (state.activeMilestoneId) throw new Error(`Cannot complete project while milestone '${state.activeMilestoneId}' is active.`);
      if (!state.milestones.length || state.milestones.some((milestone) => milestone.status !== MILESTONE_STATUSES.ACCEPTED)) {
        throw new Error('Project completion requires every milestone to be accepted.');
      }
      state.status = PROJECT_STATUSES.COMPLETED;
      break;

    default:
      throw new Error(`Unhandled project event type '${event.type}'.`);
  }

  return registerEvent(state, event, fingerprint);
}

function replayProjectEvents(events) {
  if (!Array.isArray(events) || !events.length) throw new Error('Project replay requires at least one event.');
  let state = null;
  for (const event of events) state = applyProjectEvent(state, event);
  return state;
}

module.exports = {
  applyProjectEvent,
  replayProjectEvents,
  validateMilestoneGraph,
};