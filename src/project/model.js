'use strict';

const PROJECT_STATE_VERSION = 1;

const PROJECT_STATUSES = Object.freeze({
  DRAFT: 'draft',
  DISCOVERY: 'discovery',
  AWAITING_STAKEHOLDER: 'awaiting_stakeholder',
  AWAITING_PLAN_APPROVAL: 'awaiting_plan_approval',
  EXECUTING: 'executing',
  MILESTONE_REVIEW: 'milestone_review',
  REPLANNING: 'replanning',
  PAUSED: 'paused',
  COMPLETED: 'completed',
});

const MILESTONE_STATUSES = Object.freeze({
  PLANNED: 'planned',
  ACTIVE: 'active',
  REVIEW: 'review',
  ACCEPTED: 'accepted',
});

function text(value, field) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${field} is required.`);
  return result;
}

function stringList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Expected an array.');
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function roundCredits(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function normalizeAmount(value, field) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`${field} must be a finite non-negative number.`);
  return roundCredits(amount);
}

function createBudget(total = 0, unit = 'ai_credits') {
  const normalizedTotal = normalizeAmount(total, 'budget total');
  return {
    unit: text(unit, 'budget unit'),
    total: normalizedTotal,
    spent: 0,
    reserved: 0,
    remaining: normalizedTotal,
    available: normalizedTotal,
    ledger: [],
  };
}

function normalizeExecutionTarget(value = { kind: 'local' }) {
  const target = value && typeof value === 'object' ? value : {};
  const kind = text(target.kind ?? 'local', 'execution target kind');
  if (!['local', 'garm-portainer'].includes(kind)) {
    throw new Error(`Unsupported execution target kind '${kind}'.`);
  }

  const isolation = String(target.isolation ?? 'project').trim();
  if (!['project', 'milestone', 'task'].includes(isolation)) {
    throw new Error(`Unsupported execution isolation '${isolation}'.`);
  }

  const base = {
    kind,
    isolation,
    capabilities: stringList(target.capabilities),
  };

  if (kind === 'local') {
    return {
      ...base,
      ...(target.workspaceRef ? { workspaceRef: text(target.workspaceRef, 'workspaceRef') } : {}),
    };
  }

  return {
    ...base,
    runnerLabels: stringList(target.runnerLabels),
    ...(target.pool ? { pool: text(target.pool, 'pool') } : {}),
    ...(target.portainerEndpointId ? { portainerEndpointId: text(target.portainerEndpointId, 'portainerEndpointId') } : {}),
    ...(target.image ? { image: text(target.image, 'image') } : {}),
  };
}

function createProjectState(data = {}) {
  const projectId = text(data.projectId ?? data.id, 'projectId');
  return {
    schemaVersion: PROJECT_STATE_VERSION,
    id: projectId,
    revision: 0,
    status: PROJECT_STATUSES.DRAFT,
    objective: text(data.objective, 'objective'),
    stakeholders: stringList(data.stakeholders),
    useCases: [],
    requirements: [],
    nonGoals: stringList(data.nonGoals),
    constraints: stringList(data.constraints),
    assumptions: stringList(data.assumptions),
    openQuestions: [],
    decisions: [],
    risks: [],
    feedback: [],
    planRevision: 0,
    approvedPlanRevision: null,
    milestones: [],
    activeMilestoneId: null,
    stakeholderGate: null,
    pauseResumeStatus: null,
    budget: createBudget(data.budgetTotal ?? 0, data.budgetUnit ?? 'ai_credits'),
    executionTarget: normalizeExecutionTarget(data.executionTarget ?? { kind: 'local' }),
    appliedEventFingerprints: {},
    lastEvent: null,
  };
}

module.exports = {
  PROJECT_STATE_VERSION,
  PROJECT_STATUSES,
  MILESTONE_STATUSES,
  createBudget,
  createProjectState,
  normalizeAmount,
  normalizeExecutionTarget,
  roundCredits,
  stringList,
  text,
};