'use strict';

const ROUTES = new Set(['read_only', 'trivial', 'standard', 'high_risk']);
const RISKS = new Set(['low', 'medium', 'high']);
const ARCHITECTURE_SIGNIFICANCE = new Set(['low', 'medium', 'high']);
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'];

const DOC_ONLY_HINTS = /\b(readme|documentation|docs?|markdown|comment|comments|spelling|typo|wording|text[- ]only|changelog|license)\b/i;
const EXECUTABLE_CHANGE_HINTS = /\b(source code|executable|implementation|implement|script|unit tests?|integration tests?|test file|function|class|module|api|endpoint|runtime|behavior|logic|python|javascript|typescript|java|rust|go code|c\+\+|cmake|workflow|github actions|pipeline|dockerfile|build config|build configuration)\b|\.(py|js|ts|tsx|jsx|java|rs|go|c|cc|cpp|h|hpp|cs|sh|ps1|bat)\b/i;
const HIGH_RISK_HINTS = /\b(authentication|authorization|authn|authz|security|credential|secret|token handling|encryption|migration|schema migration|database migration|data deletion|destructive|concurrency|race condition|locking|payment|billing|production deployment)\b/i;
const HIGH_ARCHITECTURE_HINTS = /\b(architectural(?:ly)?|architecture refactor|architectural refactor|cross[- ]cutting|new subsystem|new service|service boundary|runtime abstraction|runtime backend|backend provider|provider abstraction|plugin system|plugin architecture|extension point|public api redesign|internal api redesign|interface redesign|protocol redesign|persistence layer|storage layer|message queue|event bus|ipc|inter[- ]process communication|dependency injection container|orchestration engine|ownership boundary)\b/i;
const MEDIUM_ARCHITECTURE_HINTS = /\b(refactor|new runtime|new backend|new provider|new plugin|new cache|caching layer|new persistence|new storage|new protocol|new interface|compatibility layer|migration strategy)\b/i;

function normalizeRisk(value) {
  const risk = String(value ?? '').toLowerCase();
  return RISKS.has(risk) ? risk : 'medium';
}

function normalizeArchitectureSignificance(value) {
  const significance = String(value ?? '').toLowerCase();
  return ARCHITECTURE_SIGNIFICANCE.has(significance) ? significance : 'low';
}

function taskText(task) {
  return [
    task?.title,
    task?.description,
    ...(Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria : []),
    task?.routingReason,
  ].filter(Boolean).join('\n');
}

function isClearlyTrivialChange(task) {
  const text = taskText(task);
  return DOC_ONLY_HINTS.test(text) && !EXECUTABLE_CHANGE_HINTS.test(text);
}

function hasHighRiskSemantics(task) {
  return HIGH_RISK_HINTS.test(taskText(task));
}

function architectureSignificance(task) {
  if (task?.route === 'read_only') return 'low';
  const explicit = normalizeArchitectureSignificance(task?.architectureSignificance);
  if (explicit === 'high' || explicit === 'medium') return explicit;
  const text = taskText(task);
  if (HIGH_ARCHITECTURE_HINTS.test(text)) return 'high';
  if (MEDIUM_ARCHITECTURE_HINTS.test(text)) return 'medium';
  return 'low';
}

function normalizeTaskRoute(task, routingMode = 'adaptive') {
  const requested = ROUTES.has(task?.route) ? task.route : 'standard';
  let risk = normalizeRisk(task?.risk);
  let route = requested;
  const architecture = architectureSignificance(task);
  const reasons = [];

  if (hasHighRiskSemantics(task) && route !== 'read_only') {
    if (risk !== 'high') reasons.push('task semantics require high-risk treatment');
    risk = 'high';
  }

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

  if (route === 'trivial' && !isClearlyTrivialChange(task)) {
    route = 'standard';
    reasons.push('the trivial fast path is reserved for clearly documentation/comment/text-only changes; executable code, tests, scripts, build/CI changes, and ambiguous modifications use standard review');
  }

  if (route === 'read_only' && !task?.result) reasons.push('read-only route requires the coordinator to provide a result');
  if (architecture === 'high' && route !== 'read_only') reasons.push('architecturally significant change requires a bounded read-only software-architect assessment');

  const peerConvergence = route === 'high_risk' || (routingMode === 'full' && route !== 'read_only');

  return {
    route,
    risk,
    architecture,
    needsArchitect: architecture === 'high' && route !== 'read_only',
    peerConvergence,
    requestedRoute: requested,
    reason: [task?.routingReason, ...reasons].filter(Boolean).join('; '),
    overridden: route !== requested,
  };
}

function usesPeerConvergence(routing) {
  if (!routing) return false;
  if (typeof routing.peerConvergence === 'boolean') return routing.peerConvergence;
  return routing.route === 'high_risk';
}

function routePolicy(route, risk = 'medium', peerConvergence = route === 'high_risk', architecture = 'low') {
  const normalizedRisk = normalizeRisk(risk);
  const normalizedArchitecture = normalizeArchitectureSignificance(architecture);
  const architect = normalizedArchitecture === 'high' && route !== 'read_only';
  switch (route) {
    case 'read_only':
      return { description: 'Coordinator inspection only; no workspace writes or worker sessions.', workerMode: 'none', strongReview: false, architect: false, efforts: { coordinator: 'low' } };
    case 'trivial':
      return { description: 'Worker A implements a clearly text/documentation-only edit, then Worker B performs one independent review. Any B change escalates to the standard strong-review workflow.', workerMode: 'single_peer_review', strongReview: false, architect: false, efforts: { workerA: 'low', workerB: 'low' } };
    case 'high_risk':
      return { description: `${architect ? 'Read-only architecture assessment, then ' : ''}full A/B convergence plus persistent strong review with higher reasoning effort.`, workerMode: 'converge', strongReview: true, architect, efforts: { architect: 'medium', workerA: 'medium', workerB: 'medium', reviewer: 'high' } };
    case 'standard':
    default:
      if (peerConvergence) {
        return { description: `${architect ? 'Read-only architecture assessment, then ' : ''}full-routing override: Worker A/B convergence plus persistent strong review.`, workerMode: 'converge', strongReview: true, architect, efforts: { architect: 'medium', workerA: 'low', workerB: 'low', reviewer: normalizedRisk === 'low' ? 'low' : 'medium' } };
      }
      return { description: `${architect ? 'Read-only architecture assessment, then ' : ''}Worker A implements, then an independent strong reviewer validates the exact current revision. Reviewer findings return to the same Worker A for bounded remediation and delta re-review.`, workerMode: 'implementer_review', strongReview: true, architect, efforts: { architect: 'medium', workerA: 'low', workerB: 'low', reviewer: normalizedRisk === 'low' ? 'low' : 'medium' } };
  }
}

function chooseReasoningEffort(model, desired, reasoningMode = 'adaptive') {
  if (reasoningMode !== 'adaptive' || !desired) return undefined;
  const supported = Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map((value) => String(value).toLowerCase()) : [];
  if (!supported.length) return undefined;
  if (supported.includes(desired)) return desired;
  const desiredIndex = EFFORT_ORDER.indexOf(desired);
  const candidates = supported.map((value) => ({ value, index: EFFORT_ORDER.indexOf(value) })).filter((item) => item.index >= 0).sort((a, b) => {
    const aDistance = Math.abs(a.index - desiredIndex); const bDistance = Math.abs(b.index - desiredIndex);
    if (aDistance !== bDistance) return aDistance - bDistance;
    return a.index - b.index;
  });
  return candidates[0]?.value;
}

module.exports = {
  ROUTES,
  RISKS,
  ARCHITECTURE_SIGNIFICANCE,
  normalizeTaskRoute,
  routePolicy,
  usesPeerConvergence,
  chooseReasoningEffort,
  isClearlyTrivialChange,
  hasHighRiskSemantics,
  architectureSignificance,
  normalizeArchitectureSignificance,
};
