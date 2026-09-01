'use strict';

const { buildProjectManagerHandoff } = require('./handoff');

const EXECUTOR_STATES = new Set(['none', 'known-stopped', 'may-be-running']);
const WORKSPACE_STATES = new Set(['matches', 'drifted', 'unknown']);
const EXTERNAL_STATES = new Set(['reconciled', 'unknown']);

function normalizeRecoveryEvidence(value = {}) {
  const executor = String(value.executor ?? 'none').trim();
  const workspace = String(value.workspace ?? 'unknown').trim();
  const external = String(value.external ?? 'unknown').trim();
  if (!EXECUTOR_STATES.has(executor)) throw new Error(`Unknown executor recovery state '${executor}'.`);
  if (!WORKSPACE_STATES.has(workspace)) throw new Error(`Unknown workspace recovery state '${workspace}'.`);
  if (!EXTERNAL_STATES.has(external)) throw new Error(`Unknown external recovery state '${external}'.`);
  return { executor, workspace, external };
}

function planProjectRecovery(state, rawEvidence = {}) {
  if (!state || typeof state !== 'object') throw new Error('Project state is required for recovery planning.');
  const evidence = normalizeRecoveryEvidence(rawEvidence);
  const handoff = buildProjectManagerHandoff(state);
  const actions = [];

  if (state.status === 'completed') {
    return {
      safeToStartExecution: false,
      terminal: true,
      actions: [],
      continuation: 'none',
      handoff,
    };
  }

  if (evidence.executor === 'may-be-running') {
    actions.push({
      kind: 'prove_previous_executor_stopped',
      required: true,
      reason: 'Replacement execution is forbidden while a previous project executor or managed command may still be active.',
    });
  }

  if (evidence.workspace !== 'matches') {
    actions.push({
      kind: 'reconcile_workspace',
      required: true,
      state: evidence.workspace,
      reason: 'Project continuation requires a proven workspace/repository boundary before execution resumes.',
    });
  }

  if (evidence.external !== 'reconciled') {
    actions.push({
      kind: 'reconcile_external_state',
      required: true,
      reason: 'CI, PR, deployment, preview or remote-executor state must be reconciled when relevant before project decisions continue.',
    });
  }

  const safeToStartExecution = actions.length === 0
    && !['awaiting_stakeholder', 'awaiting_plan_approval', 'milestone_review', 'paused'].includes(state.status);

  return {
    safeToStartExecution,
    terminal: false,
    actions,
    continuation: handoff.continuation.nextAction,
    handoff,
  };
}

module.exports = {
  normalizeRecoveryEvidence,
  planProjectRecovery,
};