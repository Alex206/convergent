'use strict';

const {
  EvidenceObserverRegistry,
  createPathResolutionTransitionObserver,
} = require('./evidence-observers');
const {
  createDependencyOrderEvidenceObserver,
} = require('./dependency-order-evidence-observer');

const HIGH_RISK_ASSURANCE_TYPED_EVIDENCE = 'typed-evidence';
const HIGH_RISK_ASSURANCE_PEER_FALLBACK = 'peer-convergence-fallback';
const HIGH_RISK_ASSURANCE_EXISTING_ROUTE = 'existing-route';

function createResearchEvidenceObserverRegistry() {
  return new EvidenceObserverRegistry([
    createPathResolutionTransitionObserver(),
    createDependencyOrderEvidenceObserver(),
  ]);
}

function fallbackDecision({ route, risk, reason, error = null, applicability = [], selectedObservers = [] }) {
  return Object.freeze({
    mode: HIGH_RISK_ASSURANCE_PEER_FALLBACK,
    route,
    risk,
    reason,
    ...(error ? { error: String(error).slice(0, 400) } : {}),
    selectedObservers: Object.freeze(selectedObservers),
    applicability: Object.freeze(applicability),
    auditContract: null,
    fallbackRequired: true,
  });
}

function assuranceDecision({
  task,
  routing = {},
  registry = createResearchEvidenceObserverRegistry(),
} = {}) {
  const route = String(routing?.route ?? '').trim();
  const risk = String(routing?.risk ?? '').trim();

  if (risk === 'high' && route !== 'high_risk') {
    return fallbackDecision({
      route,
      risk,
      reason: 'high-risk-routing-inconsistency',
    });
  }

  if (route !== 'high_risk') {
    return Object.freeze({
      mode: HIGH_RISK_ASSURANCE_EXISTING_ROUTE,
      route,
      risk,
      reason: 'task-is-not-on-high-risk-route',
      selectedObservers: Object.freeze([]),
      applicability: Object.freeze([]),
      auditContract: null,
      fallbackRequired: false,
    });
  }

  let selection;
  try {
    selection = registry.selectApplicable({ task, routing });
  } catch (error) {
    return fallbackDecision({
      route,
      risk,
      reason: 'observer-selection-failed',
      error: error?.message ?? error,
    });
  }

  const applicability = (selection?.decisions ?? []).map((entry) => Object.freeze({ ...entry }));
  const selectedObservers = (selection?.registry?.metadata?.() ?? []).map((entry) => Object.freeze({ ...entry }));

  if (!selectedObservers.length) {
    return fallbackDecision({
      route,
      risk,
      reason: 'no-applicable-typed-observer',
      selectedObservers,
      applicability,
    });
  }

  let auditContract;
  try {
    auditContract = selection.registry.auditContract();
  } catch (error) {
    return fallbackDecision({
      route,
      risk,
      reason: 'incompatible-observer-audit-contracts',
      error: error?.message ?? error,
      selectedObservers,
      applicability,
    });
  }

  if (!auditContract?.id) {
    return fallbackDecision({
      route,
      risk,
      reason: 'observer-audit-contract-unavailable',
      selectedObservers,
      applicability,
    });
  }

  return Object.freeze({
    mode: HIGH_RISK_ASSURANCE_TYPED_EVIDENCE,
    route,
    risk,
    reason: 'applicable-compatible-typed-observer',
    selectedObservers: Object.freeze(selectedObservers),
    applicability: Object.freeze(applicability),
    auditContract: auditContract.id,
    fallbackRequired: false,
  });
}

module.exports = {
  HIGH_RISK_ASSURANCE_TYPED_EVIDENCE,
  HIGH_RISK_ASSURANCE_PEER_FALLBACK,
  HIGH_RISK_ASSURANCE_EXISTING_ROUTE,
  createResearchEvidenceObserverRegistry,
  fallbackDecision,
  assuranceDecision,
};
