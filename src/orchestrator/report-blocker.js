'use strict';

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function deniesBlockerLanguage(value) {
  return /\b(?:not|no longer|was not|is not)\s+blocked\b|\bno\s+blockers?\b/i.test(value);
}

function explicitBlockerEvidence(report = {}) {
  if (report.verdict === 'blocked') return null;
  const summary = text(report.summary);
  if (summary && !deniesBlockerLanguage(summary) && /\b(?:explicit(?:ly)?\s+)?(?:blocked|blocker)\b/i.test(summary)) {
    return summary;
  }
  for (const raw of report.checks ?? []) {
    const check = text(raw);
    if (!check || deniesBlockerLanguage(check)) continue;
    if (/\bBLOCKED\s*:/i.test(check) || /\b(?:required|external)\s+(?:validation|check)\b[^.]{0,120}\b(?:blocked|blocker|unavailable|not configured)\b/i.test(check)) {
      return check;
    }
  }
  return null;
}

function operatorPrerequisiteEvidence(detail = {}) {
  const candidates = [detail.summary, ...(detail.checks ?? [])]
    .map(text)
    .filter(Boolean);
  const prerequisite = /(?:\b(?:missing|unavailable|not configured|unset|required)\b.{0,120}\b(?:token|credential|secret|environment variable|environment prerequisite|env(?:ironment)? prerequisite)\b|\b(?:token|credential|secret|environment variable|environment prerequisite|env(?:ironment)? prerequisite)\b.{0,120}\b(?:missing|unavailable|not configured|unset|required)\b)/i;
  return candidates.find((candidate) => prerequisite.test(candidate)) ?? null;
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
  explicitBlockerEvidence,
  operatorPrerequisiteEvidence,
  reconcileExplicitValidationBlocker,
};
