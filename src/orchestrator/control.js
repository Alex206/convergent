'use strict';

const PAUSED_CODE = 'CONVERGENT_PAUSED';

class WorkflowPausedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WorkflowPausedError';
    this.code = PAUSED_CODE;
    this.details = details;
  }
}

function isWorkflowPausedError(error) {
  return error?.code === PAUSED_CODE;
}

function pauseWorkflow(message, details = {}) {
  throw new WorkflowPausedError(message, details);
}

module.exports = {
  PAUSED_CODE,
  WorkflowPausedError,
  isWorkflowPausedError,
  pauseWorkflow,
};
