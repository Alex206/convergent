'use strict';

const PROJECT_ACTORS = Object.freeze({
  projectManager: Object.freeze({
    id: 'project-manager',
    modelSelector: 'strong',
    sessionLifetime: 'episodic',
    authority: 'proposal',
    responsibilities: Object.freeze([
      'requirements-discovery',
      'stakeholder-clarification',
      'project-planning',
      'milestone-planning',
      'replanning',
      'milestone-summary',
    ]),
  }),
  projectArchitect: Object.freeze({
    id: 'project-architect',
    modelSelector: 'strong',
    sessionLifetime: 'ephemeral',
    authority: 'advisory',
    activation: 'architecture-significant-project-or-milestone-decision',
    responsibilities: Object.freeze([
      'architecture-options',
      'cross-milestone-boundaries',
      'architecture-risk-review',
    ]),
  }),
  taskEngine: Object.freeze({
    id: 'existing-convergent-task-engine',
    sessionLifetime: 'task-scoped',
    authority: 'existing-engine',
    responsibilities: Object.freeze([
      'task-decomposition',
      'implementation',
      'validation',
      'review',
      'remediation',
      'task-recovery',
    ]),
  }),
});

function projectActorPolicy() {
  return PROJECT_ACTORS;
}

module.exports = {
  PROJECT_ACTORS,
  projectActorPolicy,
};