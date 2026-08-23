'use strict';

const { normalizeTaskRoute } = require('./routing');

const MODIFY_HINTS = /\b(?:add|implement|fix|change|update|extend|support|refactor|remove|delete|replace|rename|move|create|introduce|wire|integrate|enforce|harden|optimi[sz]e|correct|migrate|convert|upgrade|downgrade|allow|prevent)\b/i;
const READ_ONLY_OPENING = /^(?:please\s+)?(?:can\s+you\s+tell|could\s+you\s+explain|would\s+you\s+explain|explain|describe|analy[sz]e|investigate|inspect|review|compare|summari[sz]e|find|locate|show|list|tell\s+me|what|why|how|which|should\s+(?:we|i)|do\s+(?:we|i)\s+need)\b/i;
const NO_MODIFICATION = /\b(?:do\s+not|don't|without)\s+(?:change|modify|edit|touch)\b/i;
const AMBIGUOUS_DESIGN = /\b(?:choose\s+between|decide\s+(?:between|whether)|trade[- ]?offs?|compare\s+(?:approaches|options|designs)|evaluate\s+(?:approaches|options|alternatives)|which\s+(?:approach|design|option)|best\s+(?:approach|design|way)|recommend\s+(?:an?\s+)?(?:approach|design|architecture)|design\s+(?:an?\s+|the\s+)?architecture|architectural\s+design|roadmap)\b/i;
const DECOMPOSITION_HINTS = /\b(?:separate(?:ly)?\s+(?:task|change|work)|independent(?:ly)?\s+(?:task|change|work)|unrelated\s+(?:task|change|work)|split\s+(?:this|the work)\s+into|break\s+(?:this|the work)\s+(?:up|down)\s+into)\b/i;
const PUBLIC_API_CHANGE_HINTS = /\b(?:change|break|redesign|replace|remove|rename|deprecat(?:e|ion)|migrat(?:e|ion)|version)\s+(?:the\s+)?public\s+api(?:\s+compatibility)?(?:\s+contract)?\b|\bpublic\s+api(?:\s+compatibility)?(?:\s+contract)?\s+(?:change|break|redesign|replacement|removal|rename|deprecation|migration|versioning)\b/i;
const RELEASE_BOUNDARY_HINTS = /\b(?:release\s+infrastructure|release\s+pipeline|production\s+rollout|production\s+release)\b/i;
const EXPLICIT_CREDENTIAL_NAME = /\b[A-Z][A-Z0-9_]*(?:_TOKEN|_SECRET|_PASSWORD|_PASSCODE|_CREDENTIALS?|_API_KEY|_ACCESS_KEY|_PRIVATE_KEY)\b/;
const MAX_DIRECT_REQUEST_CHARS = 3000;

function cleanRequest(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function topLevelNumberedActions(text) {
  return text.split('\n').filter((line) => /^\s*\d+[.)]\s+\S/.test(line)).length;
}

function imperativeBulletActions(text) {
  return text.split('\n').filter((line) => /^\s*[-*+]\s+(?:add|implement|fix|change|update|extend|support|refactor|remove|delete|replace|rename|move|create|introduce|wire|integrate|enforce|harden|optimi[sz]e|correct|migrate|convert|upgrade|allow|prevent)\b/i.test(line)).length;
}

function markdownSections(text) {
  return text.split('\n').filter((line) => /^\s*#{1,3}\s+\S/.test(line)).length;
}

function deterministicPlanningDecision(userRequest, routingMode = 'adaptive') {
  const request = cleanRequest(userRequest);
  if (!request) return { eligible: false, reason: 'empty request' };
  if (request.length > MAX_DIRECT_REQUEST_CHARS) {
    return { eligible: false, reason: 'request is too large for conservative single-task formation' };
  }
  if (READ_ONLY_OPENING.test(request)) {
    return { eligible: false, reason: 'request begins as read-only/question work' };
  }
  if (!MODIFY_HINTS.test(request)) {
    return { eligible: false, reason: 'no explicit modifying action was detected' };
  }
  if (NO_MODIFICATION.test(request) && /\b(?:explain|describe|analy[sz]e|investigate|inspect|review|compare|summari[sz]e|find|show|tell)\b/i.test(request)) {
    return { eligible: false, reason: 'request explicitly avoids modification while asking for inspection/explanation' };
  }
  if (AMBIGUOUS_DESIGN.test(request)) {
    return { eligible: false, reason: 'request contains an unresolved design/choice decision' };
  }
  if (DECOMPOSITION_HINTS.test(request)) {
    return { eligible: false, reason: 'request explicitly asks for separable/decomposed work' };
  }
  if (topLevelNumberedActions(request) >= 2 || imperativeBulletActions(request) >= 2 || markdownSections(request) >= 3) {
    return { eligible: false, reason: 'request appears to contain multiple independently actionable sections' };
  }
  if (PUBLIC_API_CHANGE_HINTS.test(request) || RELEASE_BOUNDARY_HINTS.test(request)) {
    return { eligible: false, reason: 'request contains a high-impact compatibility/release boundary that still requires planner classification' };
  }

  const candidate = {
    id: 'task-1',
    title: 'Implement requested change',
    description: request,
    acceptanceCriteria: [
      'Satisfy the complete user request and every explicit constraint without unrelated changes.',
    ],
    route: 'standard',
    risk: 'medium',
    routingReason: 'Convergent deterministically formed one cohesive modifying task from the explicit user request.',
    inspectionHints: [],
    result: '',
  };
  if (EXPLICIT_CREDENTIAL_NAME.test(request)) {
    candidate.route = 'high_risk';
    candidate.risk = 'high';
    // This is structured deterministic evidence, not prose that the routing
    // classifier must rediscover from routingReason.
    candidate.deterministicHighRisk = true;
    candidate.routingReason += ' An explicit operator-controlled credential variable requires high-risk assurance.';
  }

  const routing = normalizeTaskRoute(candidate, routingMode);
  if (routing.architecture === 'high') {
    return { eligible: false, reason: 'high architecture significance requires strong planning before the architect specialist' };
  }

  candidate.route = routing.route;
  candidate.risk = routing.risk;
  candidate.architectureSignificance = routing.architecture;
  candidate.routingReason = routing.reason || candidate.routingReason;

  return {
    eligible: true,
    reason: 'single explicit cohesive modifying request',
    plan: {
      summary: 'One cohesive modifying task formed deterministically from the user request; no planning model call was required.',
      tasks: [candidate],
    },
    routing,
  };
}

function deterministicSingleTaskPlan(userRequest, routingMode = 'adaptive') {
  const decision = deterministicPlanningDecision(userRequest, routingMode);
  return decision.eligible ? decision : null;
}

module.exports = {
  MAX_DIRECT_REQUEST_CHARS,
  deterministicPlanningDecision,
  deterministicSingleTaskPlan,
  topLevelNumberedActions,
  imperativeBulletActions,
};
