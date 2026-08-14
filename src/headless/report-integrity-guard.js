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

function hasSuccessfulCheck(report = {}) {
  return (report.checks ?? []).some((raw) => {
    const check = compact(raw);
    if (!check) return false;
    if (/\b(?:blocked|blocker|missing|unavailable|not configured|unset|failed|failure|error|non[- ]zero)\b|\bexit\s+[1-9]\d*\b/i.test(check)) {
      return false;
    }
    return /\b(?:passed|pass|succeeded|success|clean|exit\s+0)\b/i.test(check);
  });
}

function hasUnresolvedBlockerEvidence(report = {}) {
  const texts = reportTexts(report);
  return texts.some((raw) => {
    const value = raw
      .replace(/\bno unresolved issues?\b/gi, '')
      .replace(/\bno actionable issues?\b/gi, '')
      .replace(/\bno remaining issues?\b/gi, '')
      .replace(/\bno blockers?\b/gi, '')
      .replace(/\bnot blocked\b/gi, '')
      .replace(/\bno errors?\b/gi, '');
    return /\b(?:blocked|blocker|missing|unavailable|not configured|unset|cannot|unable|failed|failure|error|prerequisite)\b|\bcan['’]t\b|\bexit\s+[1-9]\d*\b|\bnon[- ]zero\b/i.test(value);
  });
}

function reconcileUnsupportedBlockedReport(report = {}, { changed = false, role = 'Agent' } = {}) {
  if (report.verdict !== 'blocked') return { report, correction: null };
  if ((report.findings ?? []).length > 0) return { report, correction: null };
  if (!hasCompletionEvidence(report)) return { report, correction: null };
  if (!hasSuccessfulCheck(report)) return { report, correction: null };
  if (hasUnresolvedBlockerEvidence(report)) return { report, correction: null };

  const verdict = changed ? 'changed' : 'clean';
  const correction = `Convergent changed ${role} BLOCKED -> ${verdict.toUpperCase()} because the structured report contains explicit completion/no-issue evidence, successful validation, no findings, and no unresolved blocker evidence.`;
  return {
    report: {
      ...report,
      verdict,
      checks: [
        ...(report.checks ?? []),
        'Convergent report-integrity check: unsupported BLOCKED verdict reconciled from the agent\'s own completion and successful-validation evidence.',
      ],
    },
    correction,
  };
}

module.exports = {
  compact,
  reportTexts,
  hasCompletionEvidence,
  hasSuccessfulCheck,
  hasUnresolvedBlockerEvidence,
  reconcileUnsupportedBlockedReport,
};
