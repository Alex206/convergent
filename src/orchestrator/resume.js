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
  if (!value.plan || typeof value.plan !== 'object' || !Array.isArray(value.plan.tasks) || !value.plan.tasks.length) return null;
  if (!RESUMABLE_STATUSES.has(value.status)) return null;

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
  const task = state.plan.tasks[state.startTaskIndex];
  const completed = state.startTaskIndex;
  const detail = state.currentTaskIndex === null
    ? `continue with task ${state.startTaskIndex + 1}`
    : `restart interrupted task ${state.currentTaskIndex + 1} from the current workspace state`;
  return `${completed}/${state.plan.tasks.length} task(s) are before the resume point; ${detail}: ${task?.title ?? task?.id ?? 'unnamed task'}.`;
}

module.exports = {
  RESUME_STATE_VERSION,
  defaultStats,
  normalizeResumeState,
  resumeSummary,
};
