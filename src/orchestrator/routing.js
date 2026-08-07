'use strict';

const ROUTES = new Set(['read_only', 'trivial', 'standard', 'high_risk']);
const RISKS = new Set(['low', 'medium', 'high']);
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'];

function normalizeRisk(value) {
  const risk = String(value ?? '').toLowerCase();
  return RISKS.has(risk) ? risk : 'medium';
}

function normalizeTaskRoute(task, routingMode = 'adaptive') {
  const requested = ROUTES.has(task?.route) ? task.route : 'standard';
  const risk = normalizeRisk(task?.risk);
  let route = requested;
  const reasons = [];

  if (routingMode === 'full' && route !== 'read_only') {
    route = risk === 'high' ? 'high_risk' : 'standard';
    if (route !== requested) reasons.push('full routing mode overrides the coordinator route');
  }

  if (risk === 'high' && route !== 'read_only' && route !== 'high_risk') {
    route = 'high_risk';
    reasons.push('high-risk changes always use the high-risk route');
  } else if (risk === 'medium' && route === 'trivial') {
    route = 'standard';
    reasons.push('medium-risk changes cannot use the trivial route');
  }

  if (route === 'read_only' && !task?.result) {
    reasons.push('read-only route requires the coordinator to provide a result');
  }

  return {
    route,
    risk,
    requestedRoute: requested,
    reason: [task?.routingReason, ...reasons].filter(Boolean).join('; '),
    overridden: route !== requested,
  };
}

function routePolicy(route) {
  switch (route) {
    case 'read_only':
      return {
        description: 'Coordinator inspection only; no workspace writes or worker sessions.',
        workerMode: 'none',
        strongReview: false,
        efforts: { coordinator: 'low' },
      };
    case 'trivial':
      return {
        description: 'Worker A implements, Worker B performs one independent review. Any B change escalates to the full standard workflow.',
        workerMode: 'single_peer_review',
        strongReview: false,
        efforts: { workerA: 'low', workerB: 'low' },
      };
    case 'high_risk':
      return {
        description: 'Full A/B convergence plus persistent strong review with higher reasoning effort.',
        workerMode: 'converge',
        strongReview: true,
        efforts: { workerA: 'medium', workerB: 'medium', reviewer: 'high' },
      };
    case 'standard':
    default:
      return {
        description: 'Full A/B convergence plus persistent strong review.',
        workerMode: 'converge',
        strongReview: true,
        efforts: { workerA: 'low', workerB: 'low', reviewer: 'medium' },
      };
  }
}

function chooseReasoningEffort(model, desired, reasoningMode = 'adaptive') {
  if (reasoningMode !== 'adaptive' || !desired) return undefined;
  const supported = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map((value) => String(value).toLowerCase())
    : [];
  if (!supported.length) return undefined;
  if (supported.includes(desired)) return desired;

  const desiredIndex = EFFORT_ORDER.indexOf(desired);
  const candidates = supported
    .map((value) => ({ value, index: EFFORT_ORDER.indexOf(value) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => {
      const aDistance = Math.abs(a.index - desiredIndex);
      const bDistance = Math.abs(b.index - desiredIndex);
      if (aDistance !== bDistance) return aDistance - bDistance;
      return a.index - b.index;
    });
  return candidates[0]?.value;
}

module.exports = {
  ROUTES,
  RISKS,
  normalizeTaskRoute,
  routePolicy,
  chooseReasoningEffort,
};
