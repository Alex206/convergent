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
  return (name.test(candidate) && missing.test(candidate));
}

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

function reconcileSupersededValidationBlocker(report = {}, priorEvidence = [], { changed = false, role = 'Agent' } = {}) {
  if (report.verdict !== 'blocked') return { report, correction: null };
  if ((report.findings ?? []).length) return { report, correction: null };
  if ((report.checks ?? []).some((check) => /Convergent denied (?:an attempt to )?synth/i.test(String(check)))) {
    return { report, correction: null };
  }
  const blockerCandidates = [report.summary, ...(report.checks ?? [])]
    .map(text)
    .filter(Boolean)
    .filter(validationBlockerEvidence);
  let blocker = null;
  let prior = null;
  for (const candidate of blockerCandidates) {
    const matching = matchingSuccessfulValidationEvidence(candidate, priorEvidence);
    if (!matching) continue;
    blocker = candidate;
    prior = matching;
    break;
  }
  if (!blocker || !prior) return { report, correction: null };

  const verdict = changed ? 'changed' : 'clean';
  const source = prior.agent ? ` by ${prior.agent}` : '';
  const correction = `Convergent changed ${role} BLOCKED -> ${verdict.toUpperCase()} because the same required validator already succeeded${source} on this exact workspace revision; rerunning it without the operator-authorized prerequisite does not invalidate that evidence.`;
  return {
    report: {
      ...report,
      verdict,
      checks: [
        ...(report.checks ?? []),
        `Convergent exact-revision validation evidence: ${prior.identity} already succeeded${source}; the later missing-prerequisite rerun is non-authoritative.`,
      ],
      summary: [
        report.summary,
        `Required validation ${prior.identity} already has successful evidence on this exact revision${source}.`,
      ].filter(Boolean).join(' '),
    },
    correction,
  };
}

function explicitBlockerEvidence(report = {}) {
  if (report.verdict === 'blocked') return null;
  const candidates = [report.summary, ...(report.checks ?? [])].map(text).filter(Boolean);
  return candidates.find(validationBlockerEvidence) ?? null;
}

function operatorPrerequisiteEvidence(detail = {}) {
  const candidates = [detail.summary, ...(detail.checks ?? [])]
    .map(text)
    .filter(Boolean);
  const genericPrerequisite = /(?:\b(?:missing|unavailable|not configured|unset|required|not set|not present)\b.{0,120}\b(?:token|credential|secret|password|environment variable|environment prerequisite|env(?:ironment)? prerequisite)\b|\b(?:token|credential|secret|password|environment variable|environment prerequisite|env(?:ironment)? prerequisite)\b.{0,120}\b(?:missing|unavailable|not configured|unset|required|not set|not present)\b)/i;
  return candidates.find((candidate) => genericPrerequisite.test(candidate) || namedCredentialPrerequisite(candidate)) ?? null;
}

function reconcileExplicitValidationBlocker(report = {}) {
  const evidence = explicitBlockerEvidence(report);
  if (!evidence) return { report, correction: null };
  return {
    report: {
      ...report,
      verdict: 'blocked',
      summary: report.summary || `Required validation is blocked: ${evidence}`,
    },
    correction: `Convergent changed ${String(report.verdict ?? '').toUpperCase()} -> BLOCKED because the agent's own structured validation evidence reports an unresolved required-validation blocker.`,
  };
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
