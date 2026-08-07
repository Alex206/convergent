'use strict';

const RESUME_STATE_VERSION = 1;
const RESUMABLE_STATUSES = new Set(['ready', 'running', 'interrupted']);

function defaultStats(taskCount = 0) {
  return { tasks: taskCount, trivial: 0, full: 0, readOnly: 0, escalations: 0 };
}

function normalizedStats(value, taskCount) {
  const base = defaultStats(taskCount);
  if (!value || typeof value !== 'object') return base;
  for (const key of Object.keys(base)) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) base[key] = Math.floor(number);
  }
  base.tasks = taskCount;
  return base;
}

function normalizeResumeState(value, workspace) {
  if (!value || typeof value !== 'object') return null;
  if (value.version !== RESUME_STATE_VERSION) return null;
  if (typeof value.workspace !== 'string' || value.workspace !== workspace) return null;
  if (typeof value.request !== 'string' || !value.request.trim()) return null;
  if (!RESUMABLE_STATUSES.has(value.status)) return null;

  const hasPlan = Boolean(value.plan && typeof value.plan === 'object' && Array.isArray(value.plan.tasks) && value.plan.tasks.length);
  if (!hasPlan) {
    if (value.stage !== 'planning') return null;
    return {
      ...value,
      version: RESUME_STATE_VERSION,
      workspace,
      request: value.request.trim(),
      plan: null,
      status: value.status,
      nextTaskIndex: 0,
      currentTaskIndex: null,
      startTaskIndex: 0,
      stats: defaultStats(0),
    };
  }

  const taskCount = value.plan.tasks.length;
  const nextTaskIndex = Number.isInteger(value.nextTaskIndex)
    ? Math.min(Math.max(value.nextTaskIndex, 0), taskCount)
    : 0;
  const currentTaskIndex = Number.isInteger(value.currentTaskIndex)
    && value.currentTaskIndex >= 0
    && value.currentTaskIndex < taskCount
    ? value.currentTaskIndex
    : null;
  const startTaskIndex = currentTaskIndex ?? nextTaskIndex;
  if (startTaskIndex >= taskCount) return null;

  return {
    ...value,
    version: RESUME_STATE_VERSION,
    workspace,
    request: value.request.trim(),
    status: value.status,
    nextTaskIndex,
    currentTaskIndex,
    startTaskIndex,
    stats: normalizedStats(value.stats, taskCount),
  };
}

function resumeSummary(state) {
  if (!state) return 'No resumable Convergent workflow is available.';
  if (!state.plan) return 'Planning was interrupted before a plan was accepted; resume will re-run planning with the saved user request.';
  const task = state.plan.tasks[state.startTaskIndex];
  const completed = state.startTaskIndex;
  let detail;
  if (state.currentTaskIndex === null) {
    detail = `continue with task ${state.startTaskIndex + 1}`;
  } else if (state.taskState?.stage === 'strong_review_findings') {
    detail = `resume task ${state.currentTaskIndex + 1} from strong-review remediation cycle ${state.taskState.reviewCycle ?? '?'}`;
  } else if (state.taskState?.stage === 'strong_review_pending') {
    detail = `resume task ${state.currentTaskIndex + 1} at strong-review cycle ${state.taskState.nextReviewCycle ?? '?'}`;
  } else {
    detail = `restart interrupted task ${state.currentTaskIndex + 1} from the current workspace state`;
  }
  return `${completed}/${state.plan.tasks.length} task(s) are before the resume point; ${detail}: ${task?.title ?? task?.id ?? 'unnamed task'}.`;
}

module.exports = {
  RESUME_STATE_VERSION,
  defaultStats,
  normalizeResumeState,
  resumeSummary,
};
