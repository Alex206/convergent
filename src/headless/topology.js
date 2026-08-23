'use strict';

const TOPOLOGIES = Object.freeze({
  'terra-solo': Object.freeze({
    label: 'Terra solo',
    kind: 'single_agent',
    peerMode: 'none',
    promptProfile: 'baseline',
    selectors: {
      coordinator: 'gpt-5.6-terra',
      workerA: 'gpt-5.6-terra',
      workerB: 'gpt-5.6-terra',
      reviewer: 'gpt-5.6-terra',
    },
  }),
  'luna-terra': Object.freeze({
    label: 'Luna + Terra review',
    kind: 'convergent',
    peerMode: 'none',
    promptProfile: 'production',
    selectors: {
      coordinator: 'gpt-5.6-terra',
      workerA: 'gpt-5.6-luna',
      workerB: 'adaptive-diverse',
      reviewer: 'gpt-5.6-terra',
    },
  }),
  'luna-terra-compact': Object.freeze({
    label: 'Luna + Terra review (compact standard prompts)',
    kind: 'convergent',
    peerMode: 'none',
    promptProfile: 'compact-standard',
    selectors: {
      coordinator: 'gpt-5.6-terra',
      workerA: 'gpt-5.6-luna',
      workerB: 'adaptive-diverse',
      reviewer: 'gpt-5.6-terra',
    },
  }),
  'luna-terra-lean': Object.freeze({
    label: 'Luna + Terra review (lean standard context)',
    kind: 'convergent',
    peerMode: 'none',
    promptProfile: 'lean-standard',
    toolProfile: 'lean',
    selectors: {
      coordinator: 'gpt-5.6-terra',
      workerA: 'gpt-5.6-luna',
      workerB: 'adaptive-diverse',
      reviewer: 'gpt-5.6-terra',
    },
  }),
  'luna-terra-structured': Object.freeze({
    label: 'Luna + Terra review (structured capabilities)',
    kind: 'convergent',
    peerMode: 'none',
    promptProfile: 'lean-standard',
    toolProfile: 'structured',
    selectors: {
      coordinator: 'gpt-5.6-terra',
      workerA: 'gpt-5.6-luna',
      workerB: 'adaptive-diverse',
      reviewer: 'gpt-5.6-terra',
    },
  }),
  'luna-luna-structured': Object.freeze({
    label: 'Luna + Luna review (structured capabilities)',
    kind: 'convergent',
    peerMode: 'none',
    promptProfile: 'lean-standard',
    toolProfile: 'structured',
    selectors: {
      coordinator: 'gpt-5.6-terra',
      workerA: 'gpt-5.6-luna',
      workerB: 'adaptive-diverse',
      reviewer: 'gpt-5.6-luna',
    },
  }),
  'luna-terra-capable': Object.freeze({
    label: 'Luna + Terra review (evidence-first, full capabilities)',
    kind: 'convergent',
    peerMode: 'none',
    promptProfile: 'lean-standard',
    toolProfile: 'full',
    selectors: {
      coordinator: 'gpt-5.6-terra',
      workerA: 'gpt-5.6-luna',
      workerB: 'adaptive-diverse',
      reviewer: 'gpt-5.6-terra',
    },
  }),
  'luna-peer-terra': Object.freeze({
    label: 'Luna + read-only peer critic + Terra review',
    kind: 'convergent',
    peerMode: 'critic',
    promptProfile: 'production',
    selectors: {
      coordinator: 'gpt-5.6-terra',
      workerA: 'gpt-5.6-luna',
      workerB: 'adaptive-diverse',
      reviewer: 'gpt-5.6-terra',
    },
  }),
  'luna-ab-terra': Object.freeze({
    label: 'Luna + Terra review (trust-boundary composition contract; benchmark only)',
    kind: 'convergent',
    peerMode: 'none',
    promptProfile: 'lean-standard',
    toolProfile: 'structured',
    selectors: {
      coordinator: 'gpt-5.6-terra',
      workerA: 'gpt-5.6-luna',
      workerB: 'adaptive-diverse',
      reviewer: 'gpt-5.6-terra',
    },
  }),
  'terra-terra': Object.freeze({
    label: 'Terra implementer + Terra review',
    kind: 'convergent',
    peerMode: 'none',
    promptProfile: 'production',
    selectors: {
      coordinator: 'gpt-5.6-terra',
      workerA: 'gpt-5.6-terra',
      workerB: 'adaptive-diverse',
      reviewer: 'gpt-5.6-terra',
    },
  }),
});

const DEFAULT_TOPOLOGY = 'luna-ab-terra';

function normalizeTopology(value) {
  const topology = String(value ?? DEFAULT_TOPOLOGY).trim().toLowerCase();
  if (!Object.hasOwn(TOPOLOGIES, topology)) {
    throw new Error(`Unsupported benchmark topology ${JSON.stringify(value)}. Expected one of: ${Object.keys(TOPOLOGIES).join(', ')}.`);
  }
  return topology;
}

function topologyConfig(value) {
  return TOPOLOGIES[normalizeTopology(value)];
}

function applyTopologySelectors(options = {}) {
  const topology = normalizeTopology(options.topology);
  const config = topologyConfig(topology);
  return {
    ...options,
    topology,
    coordinator: config.selectors.coordinator,
    workerA: config.selectors.workerA,
    workerB: config.selectors.workerB,
    reviewer: config.selectors.reviewer,
  };
}

function topologyNames() {
  return Object.keys(TOPOLOGIES);
}

module.exports = {
  TOPOLOGIES,
  DEFAULT_TOPOLOGY,
  normalizeTopology,
  topologyConfig,
  applyTopologySelectors,
  topologyNames,
};
