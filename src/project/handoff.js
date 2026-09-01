'use strict';

const crypto = require('node:crypto');

function compactMilestone(milestone) {
  return {
    id: milestone.id,
    objective: milestone.objective,
    status: milestone.status,
    dependencies: milestone.dependencies,
    acceptanceCriteria: milestone.acceptanceCriteria,
    budgetAllocation: milestone.budgetAllocation,
    taskCount: Array.isArray(milestone.tasks) ? milestone.tasks.length : 0,
  };
}

function nextAction(state) {
  if (state.status === 'draft') return 'start_discovery';
  if (state.status === 'discovery') return 'continue_discovery_or_propose_plan';
  if (state.status === 'awaiting_stakeholder') return 'wait_for_stakeholder_answer';
  if (state.status === 'awaiting_plan_approval') return 'wait_for_plan_approval';
  if (state.status === 'milestone_review') return 'wait_for_milestone_feedback_or_acceptance';
  if (state.status === 'replanning') return 'revise_plan_from_feedback';
  if (state.status === 'paused') return 'wait_for_resume';
  if (state.status === 'completed') return 'none';
  if (state.status === 'executing') {
    return state.activeMilestoneId ? 'continue_active_milestone' : 'start_next_ready_milestone';
  }
  return 'reconcile_project_state';
}

function buildProjectManagerHandoff(state) {
  if (!state || typeof state !== 'object') throw new Error('Project state is required for handoff.');

  const handoff = {
    schemaVersion: 1,
    project: {
      id: state.id,
      revision: state.revision,
      status: state.status,
      objective: state.objective,
    },
    stakeholders: [...state.stakeholders],
    useCases: state.useCases.map((item) => ({ ...item })),
    requirements: state.requirements
      .filter((item) => item.status !== 'retired')
      .map((item) => ({ ...item })),
    decisions: state.decisions.map((item) => ({ ...item })),
    openQuestions: state.openQuestions
      .filter((item) => item.status === 'open')
      .map((item) => ({ id: item.id, text: item.text, reason: item.reason })),
    plan: {
      revision: state.planRevision,
      approvedRevision: state.approvedPlanRevision,
      milestones: state.milestones.map(compactMilestone),
      activeMilestoneId: state.activeMilestoneId,
    },
    budget: {
      unit: state.budget.unit,
      total: state.budget.total,
      spent: state.budget.spent,
      reserved: state.budget.reserved,
      remaining: state.budget.remaining,
      available: state.budget.available ?? state.budget.remaining - state.budget.reserved,
    },
    executionTarget: { ...state.executionTarget },
    stakeholderGate: state.stakeholderGate ? { ...state.stakeholderGate } : null,
    continuation: {
      nextAction: nextAction(state),
      rule: 'Treat this handoff plus current deterministic repository/external evidence as authoritative. Do not assume access to any prior model session or hidden scratchpad.',
    },
  };

  const serialized = JSON.stringify(handoff);
  handoff.handoffId = crypto.createHash('sha256').update(serialized).digest('hex');
  return handoff;
}

module.exports = {
  buildProjectManagerHandoff,
  nextAction,
};