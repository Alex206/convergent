'use strict';

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function reportTexts(report = {}) {
  return [report.summary, ...(report.checks ?? [])].map(compact).filter(Boolean);
}

function hasCompletionEvidence(report = {}) {
  const summary = compact(report.summary);
  if (!summary) return false;
  return /\b(?:no unresolved issues?|no actionable issues?|no remaining issues?|implementation (?:is|remains) (?:complete|correct)|(?:current )?implementation satisfies (?:the |all )?(?:request|requirements?|acceptance criteria)|all (?:explicit )?requirements? (?:are|were) satisfied|fully implemented|ready for (?:review|final review))\b/i.test(summary);
}

function hasExplicitNoIssueEvidence(report = {}) {
  const summary = compact(report.summary);
  if (!summary) return false;
  return /\b(?:no unresolved issues?|no actionable issues?|no remaining issues?|no blockers?|not blocked)\b/i.test(summary);
}

function hasSuccessfulCheck(report = {}) {
  return (report.checks ?? []).some((raw) => {
    const check = compact(raw);
    if (!check) return false;
    if (/\b(?:blocked|blocker|missing|unavailable|not configured|unset|failed|failure|error|non[- ]zero)\b|\bexit(?:ed| code)?\s+[1-9]\d*\b/i.test(check)) {
      return false;
    }
    return /\b(?:passed|pass|succeeded|success|clean|exit(?:ed| code)?\s+0)\b/i.test(check);
  });
}

function hasUnresolvedBlockerEvidence(report = {}) {
  return reportTexts(report).some((raw) => {
    const value = raw
      .replace(/\bno unresolved issues?\b/gi, '')
      .replace(/\bno actionable issues?\b/gi, '')
      .replace(/\bno remaining issues?\b/gi, '')
      .replace(/\bno blockers?\b/gi, '')
      .replace(/\bnot blocked\b/gi, '')
      .replace(/\bno errors?\b/gi, '');
    return /\b(?:blocked|blocker|missing|unavailable|not available|not configured|unset|cannot|unable|failed|failure|error|prerequisite|offline|unreachable|not reachable|timeout|timed out|permission denied|access denied|connection (?:was )?refused|connection (?:was )?reset|skipped|not installed|not running)\b|\bcould\s+not\b|\bcouldn['’]t\b|\bcan['’]t\b|\bexit(?:ed| code)?\s+[1-9]\d*\b|\bnon[- ]zero\b/i.test(value);
  });
}

// These helpers remain useful for diagnostics and tests, but semantic report
// prose must not override the structured verdict. A BLOCKED report remains
// BLOCKED until a model submits a different structured verdict on a later pass.
// Deterministic overrides belong to deterministic facts such as workspace
// fingerprints, credential-integrity violations, or managed-command state.
function reconcileUnsupportedBlockedReport(report = {}, _options = {}) {
  return { report, correction: null };
}

module.exports = {
  compact,
  reportTexts,
  hasCompletionEvidence,
  hasExplicitNoIssueEvidence,
  hasSuccessfulCheck,
  hasUnresolvedBlockerEvidence,
  reconcileUnsupportedBlockedReport,
};
