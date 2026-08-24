'use strict';

const {
  ORIGIN_PROBE_TOOL,
  REVIEWER_ORIGIN_PROBE_PROMPT,
  createRedirectOriginProbeTool,
} = require('./reviewer-origin-probe');

const REDIRECT_ORIGIN_OBSERVER_ID = 'redirect-origin-transition-v1';
const MAX_AUDITOR_ORIGIN_OBSERVATIONS = 4;

const REVIEW_AUDITOR_ORIGIN_PROMPT = `
Apply the evidence contract especially strictly to the redirect-origin boundary.

The review report can contain a PROGRAMMATIC ORIGIN PROBE EVIDENCE entry. That entry is authoritative bounded evidence captured from actual probe_redirect_chain executions against the exact workspace revision being approved; it is not reviewer prose. Use it to verify the reviewer's claims. Do not infer a probe happened from prose alone, and do not credit stale evidence from another revision.

Derive the semantic distinction from the TASK CONTRACT before judging CLEAN. The relevant restrictive rule is about the origin of **every sequentially resolved hop**, while the permissive rule keeps legitimate same-origin URL-reference transitions valid. A claimed hostile/benign pair is adequate only if:
- the hostile witness actually has an intermediate resolved hop outside the trusted origin;
- a later hostile hop returns to a final trusted-origin URL, so a final-state-only implementation could plausibly accept it;
- the authoritative observation records the normalized scheme/hostname/effective-port relation and actual resolver outcome for each hop;
- the benign witness is a comparable multi-hop chain whose hops remain on the trusted origin while exercising permitted URL-reference transitions, not merely an easy one-hop happy path;
- the report explicitly identifies the security-relevant difference as origin crossing, rather than superficial differences in path text;
- the benign witness would expose an over-restrictive remediation that rejected all multi-hop redirects, all absolute redirects, or all relative parent navigation instead of enforcing the actual per-hop origin invariant.

A direct external redirect whose final URL is still cross-origin does not expose the masked-transition defect. Likewise, a benign case that does not exercise meaningful multi-hop resolution cannot prove preservation of the corresponding permissive rule.

For this benchmark, set matched_contrast_pair, overrestriction_guard, and discriminating_evidence true only when current-revision PROGRAMMATIC ORIGIN PROBE EVIDENCE supports those claims. If the evidence lacks an outside→trusted final transition and a comparable all-trusted counterpart, reject the CLEAN evidence. Do not invent a hidden URL or expected result; derive the required semantic boundary only from the supplied task contract and actual typed observations.
`.trim();

function compactOriginEvidence(observations = [], revision, maxObservations = MAX_AUDITOR_ORIGIN_OBSERVATIONS) {
  const expectedRevision = String(revision ?? '');
  return (Array.isArray(observations) ? observations : [])
    .filter((entry) => entry?.revision === expectedRevision && entry?.spec && entry?.result)
    .slice(-Math.max(1, Number(maxObservations) || MAX_AUDITOR_ORIGIN_OBSERVATIONS))
    .map((entry, index) => ({
      id: `origin-probe-${index + 1}`,
      base_url: entry.spec.base_url,
      cases: entry.spec.cases,
      trusted_origin: entry.result.trusted_origin,
      results: entry.result.results,
    }));
}

function augmentReviewWithProgrammaticOriginEvidence(review, evidence, revision) {
  const checks = Array.isArray(review?.checks) ? review.checks : [];
  const payload = {
    workspace_revision: String(revision ?? '').slice(0, 16),
    source: 'captured probe_redirect_chain tool executions on this exact revision',
    observations: evidence,
  };
  return {
    ...review,
    checks: [
      ...checks,
      `PROGRAMMATIC ORIGIN PROBE EVIDENCE (authoritative; current revision only): ${JSON.stringify(payload)}`,
    ],
  };
}

function createRedirectOriginTransitionObserver() {
  return Object.freeze({
    id: REDIRECT_ORIGIN_OBSERVER_ID,
    schemaVersion: 1,
    evidenceType: 'url.redirect-origin-transition',
    toolName: ORIGIN_PROBE_TOOL,
    reviewerPrompt: REVIEWER_ORIGIN_PROBE_PROMPT,
    auditorPrompt: REVIEW_AUDITOR_ORIGIN_PROMPT,
    metadata: Object.freeze({
      oracleBlind: true,
      revisionBound: true,
      typedTransitions: true,
      repositoryWrites: false,
    }),
    createTool({ defineTool, workspace, observationSink }) {
      return createRedirectOriginProbeTool(defineTool, { workspace, observationSink });
    },
    compactEvidence(observations, revision) {
      return compactOriginEvidence(observations, revision);
    },
    augmentReview(review, evidence, revision) {
      return augmentReviewWithProgrammaticOriginEvidence(review, evidence, revision);
    },
  });
}

module.exports = {
  REDIRECT_ORIGIN_OBSERVER_ID,
  MAX_AUDITOR_ORIGIN_OBSERVATIONS,
  REVIEW_AUDITOR_ORIGIN_PROMPT,
  compactOriginEvidence,
  augmentReviewWithProgrammaticOriginEvidence,
  createRedirectOriginTransitionObserver,
};
