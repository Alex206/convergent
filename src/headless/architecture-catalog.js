'use strict';

const {
  ARCHITECTURES,
  normalizeArchitecture,
  architectureMetadata,
} = require('./topologies');

const COPILOT_DEFAULT = 'copilot-default';

function normalizeBenchmarkArchitecture(value) {
  const normalized = String(value ?? ARCHITECTURES.CONVERGENT_V02).trim().toLowerCase();
  if (['copilot-default', 'default-copilot', 'default-agent', 'copilot'].includes(normalized)) {
    return COPILOT_DEFAULT;
  }
  return normalizeArchitecture(value);
}

function benchmarkArchitectureMetadata(architecture, options = {}) {
  const id = normalizeBenchmarkArchitecture(architecture);
  if (id === COPILOT_DEFAULT) {
    return {
      id,
      topology: 'one default Copilot SDK agent session',
      activeRoles: ['default-agent'],
      selectors: { defaultAgent: options.workerA ?? 'auto' },
      defaultCopilotPersona: true,
      customConvergentTools: false,
      independentReviewer: false,
      peerConvergence: false,
      coordinator: false,
    };
  }
  return architectureMetadata(id, options);
}

module.exports = {
  COPILOT_DEFAULT,
  normalizeBenchmarkArchitecture,
  benchmarkArchitectureMetadata,
};
