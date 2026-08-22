'use strict';

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function deniesBlockerLanguage(value) {
  return /\b(?:not|no longer|was not|is not)\s+blocked\b|\bno\s+blockers?\b/i.test(value);
}

function explicitValidationSuccess(value) {
  const candidate = text(value);
  return /\b(?:required\s+|external\s+)?(?:validator|validation|check)\b.{0,50}\b(?:passes|passed|succeeds|succeeded|successful|clean)\b/i.test(candidate)
    || /\b(?:passes|passed|succeeds|succeeded|successful|clean)\b.{0,30}\b(?:required\s+|external\s+)?(?:validator|validation|check)\b/i.test(candidate);
}

function strongUnresolvedBlockerLanguage(value) {
  const candidate = text(value);
  return /\b(?:blocked|blocker|unavailable|not configured|unset|prerequisite|failed|failure|error|non[- ]zero)\b|\bexit(?:ed| code)?\s+[1-9]\d*\b/i.test(candidate);
}

function namedCredentialPrerequisite(value) {
  const candidate = text(value);
  if (!candidate) return false;
  const name = /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSCODE|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY)\b/;
  const missing = /\b(?:missing|unavailable|not configured|unset|required|not set|not present)\b/i;
  return name.test(candidate) && missing.test(candidate);
}

// These prose helpers remain available for diagnostics/tests, but semantic text
// is not deterministic evidence. Workflow control must follow the model's
// structured verdict plus Convergent-owned facts (workspace fingerprints,
// credential-integrity violations, managed-command state, termination proof).
function validationBlockerEvidence(value) {
  const candidate = text(value);
  if (!candidate || deniesBlockerLanguage(candidate)) return false;
  if (/\bBLOCKED\s*:/i.test(candidate)) return true;

  const successful = explicitValidationSuccess(candidate);
  const strongUnresolved = strongUnresolvedBlockerLanguage(candidate);

  if (namedCredentialPrerequisite(candidate)) {
    if (successful && !strongUnresolved) return false;
    return true;
  }
  if (/\bblocked as expected\b/i.test(candidate)
    && /\b(?:missing|unavailable|not configured|unset|required|prerequisite|credential|token|secret|environment)\b/i.test(candidate)) {
    return true;
  }
  const validationContext = /\b(?:required|external)\b.{0,80}\b(?:validation|validator|check)\b|\b(?:validation|validator|check)\b.{0,80}\b(?:required|external)\b/i;
  const unresolved = /\b(?:blocked|blocker|unavailable|not configured|missing|unset|prerequisite|failed|failure|error|non[- ]zero)\b|\bexit(?:ed| code)?\s+[1-9]\d*\b/i;
  if (!validationContext.test(candidate) || !unresolved.test(candidate)) return false;
  if (successful && !strongUnresolved) return false;
  return true;
}

function validationIdentity(value) {
  const candidate = text(value).replace(/\\/g, '/');
  const pathMatch = candidate.match(/(?:^|[\s`'"])([A-Za-z0-9_.\/-]*(?:validat|verif|check)[A-Za-z0-9_.\/-]*\.(?:py|js|mjs|cjs|sh|ps1|cmd|bat|exe))(?=$|[\s`'":(),])/i);
  if (pathMatch) return pathMatch[1].toLowerCase();
  const namedMatch = candidate.match(/\b((?:required|external)[ -]?(?:validator|validation|check)[A-Za-z0-9_.\/-]*)\b/i);
  return namedMatch ? namedMatch[1].toLowerCase().replace(/\s+/g, '-') : null;
}

function successfulValidationEvidence(value) {
  const candidate = text(value);
  const identity = validationIdentity(candidate);
  if (!identity) return null;
  if (/\b(?:blocked|failed|failure|error|unavailable|missing|not configured|unset|non[- ]zero)\b|\bexit(?:ed| code)?\s+[1-9]\d*\b/i.test(candidate)) return null;
  if (!/\b(?:passed|pass|succeeded|success|successful|clean)\b|\bexit(?:ed| code)?\s+0\b/i.test(candidate)) return null;
  return { identity, evidence: candidate };
}

function matchingSuccessfulValidationEvidence(blockerEvidence, priorEvidence = []) {
  const identity = validationIdentity(blockerEvidence);
  if (!identity) return null;
  for (const item of priorEvidence ?? []) {
    const value = typeof item === 'string' ? item : item?.check;
    const successful = successfulValidationEvidence(value);
    if (successful?.identity === identity) return { ...successful, agent: item?.agent ?? null };
  }
  return null;
}

// Structured BLOCKED is authoritative. Do not infer a different verdict from
// summary/check prose, even when that prose appears inconsistent with the
// verdict. The reporting schema and recovery coordinator own that semantic
// judgement; deterministic code only enforces deterministic invariants.
function reconcileSupersededValidationBlocker(report = {}, _priorEvidence = [], _options = {}) {
  return { report, correction: null };
}

function explicitBlockerEvidence(report = {}) {
  if (report.verdict === 'blocked') return null;
  const candidates = [report.summary, ...(report.checks ?? [])].map(text).filter(Boolean);
  return candidates.find(validationBlockerEvidence) ?? null;
}

// Kept as a compatibility/diagnostic hook. Recovery must not force ask_user by
// regex-parsing arbitrary model prose; the recovery coordinator already receives
// the structured blocker and is explicitly instructed to ask for genuine
// operator-controlled prerequisites.
function operatorPrerequisiteEvidence(_detail = {}) {
  return null;
}

// Non-BLOCKED structured verdicts are equally authoritative. In particular,
// FINDINGS must stay FINDINGS so remediation proceeds instead of being diverted
// through the blocker recovery path merely because a check description contains
// words such as "failed", "blocked", or "prerequisite".
function reconcileExplicitValidationBlocker(report = {}) {
  return { report, correction: null };
}

module.exports = {
  explicitValidationSuccess,
  strongUnresolvedBlockerLanguage,
  namedCredentialPrerequisite,
  validationBlockerEvidence,
  validationIdentity,
  successfulValidationEvidence,
  matchingSuccessfulValidationEvidence,
  reconcileSupersededValidationBlocker,
  explicitBlockerEvidence,
  operatorPrerequisiteEvidence,
  reconcileExplicitValidationBlocker,
};
