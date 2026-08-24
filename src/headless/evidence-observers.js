'use strict';

const {
  PATH_PROBE_TOOL,
  REVIEWER_PATH_PROBE_PROMPT,
  createPathResolutionProbeTool,
} = require('./reviewer-path-probe');

const MAX_AUDITOR_PROBE_OBSERVATIONS = 4;
const PATH_RESOLUTION_OBSERVER_ID = 'path-resolution-transition-v1';

const REVIEW_AUDITOR_BOUNDARY_PROMPT = `
Apply the evidence contract especially strictly at acceptance-rule boundaries.

The review report can contain a PROGRAMMATIC PROBE EVIDENCE entry. That entry is authoritative bounded evidence captured from actual probe_path_resolution executions against the exact workspace revision being approved; it is not reviewer prose. Use it to verify the reviewer's claims. Do not infer a probe happened from prose alone, and do not credit stale evidence from another revision.

Derive the semantic distinctions from the TASK CONTRACT before judging the review report. When the task contains both a permissive rule and a restrictive rule over closely related transformations, a claimed matched hostile/benign pair is adequate only if:
- the hostile witness exercises the restrictive rule at its boundary and the authoritative observation records its concrete outcome;
- for a transition/provenance invariant, the hostile witness later converges to a final state that a final-state-only implementation could plausibly mistake as allowed; a case whose final state remains plainly invalid/outside is not discriminating for that invariant;
- the benign witness exercises the permissive rule at its boundary, not merely an easier happy path, and its concrete outcome is present in the authoritative observations;
- if the contract permits the same controversial intermediate boundary transition under a different provenance or mechanism, BOTH witnesses must actually exercise that boundary transition and converge to comparable final states; the security-relevant provenance/mechanism should be the material difference;
- the benign witness would actually fail under the plausible over-restrictive remediation suggested by the hostile finding.

A benign case that never reaches the controversial intermediate boundary state cannot prove preservation of a rule that explicitly permits such a transition. Likewise, a hostile case that never returns to an otherwise allowed-looking final state cannot expose a final-state-only near miss.

For this benchmark, set matched_contrast_pair, overrestriction_guard, and discriminating_evidence true only when the PROGRAMMATIC PROBE EVIDENCE for the current revision supports those claims. If there is no current-revision programmatic evidence for the claimed pair, reject the CLEAN evidence. Do not invent a hidden test case; derive the needed semantic boundary only from the supplied task contract and actual observations.
`.trim();

function injectSystemPromptIntoClient(baseClient, extraPrompt) {
  const proxy = Object.create(baseClient);
  proxy.createSession = async (options = {}) => {
    const originalPrompt = options.systemMessage?.content ?? '';
    return baseClient.createSession({
      ...options,
      systemMessage: {
        mode: 'append',
        content: [originalPrompt, extraPrompt].filter(Boolean).join('\n\n'),
      },
    });
  };
  return proxy;
}

function compactProbeEvidence(observations = [], revision, maxObservations = MAX_AUDITOR_PROBE_OBSERVATIONS) {
  const expectedRevision = String(revision ?? '');
  return (Array.isArray(observations) ? observations : [])
    .filter((entry) => entry?.revision === expectedRevision && entry?.spec && entry?.result)
    .slice(-Math.max(1, Number(maxObservations) || MAX_AUDITOR_PROBE_OBSERVATIONS))
    .map((entry, index) => ({
      id: `probe-${index + 1}`,
      root_name: entry.spec.root_name,
      directories: entry.spec.directories,
      symlinks: entry.spec.symlinks,
      cases: entry.spec.cases,
      symlink_supported: entry.result.symlink_supported,
      symlink_error: entry.result.symlink_error,
      results: entry.result.results,
    }));
}

function augmentReviewWithProgrammaticProbeEvidence(review, probeEvidence, revision) {
  const checks = Array.isArray(review?.checks) ? review.checks : [];
  const payload = {
    workspace_revision: String(revision ?? '').slice(0, 16),
    source: 'captured probe_path_resolution tool executions on this exact revision',
    observations: probeEvidence,
  };
  return {
    ...review,
    checks: [
      ...checks,
      `PROGRAMMATIC PROBE EVIDENCE (authoritative; current revision only): ${JSON.stringify(payload)}`,
    ],
  };
}

function taskContractText(task) {
  return [
    task?.title,
    task?.description,
    ...(Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria : []),
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function pathResolutionObserverApplicability({ task, routing } = {}) {
  if (routing?.route !== 'high_risk') {
    return { applicable: false, reason: 'requires-high-risk-route' };
  }
  const contract = taskContractText(task);
  const namesResolver = /\bresolve_artifact_path\b/.test(contract);
  const namesArtifactPathBoundary = /artifact[- ]path/.test(contract)
    && /\b(root|containment|descendant)\b/.test(contract)
    && /\bsymlink\b|symbolic link/.test(contract);
  if (!namesResolver && !namesArtifactPathBoundary) {
    return { applicable: false, reason: 'task-contract-does-not-identify-artifact-path-boundary' };
  }
  return {
    applicable: true,
    reason: namesResolver
      ? 'task-contract-identifies-resolve_artifact_path-boundary'
      : 'task-contract-identifies-artifact-path-symlink-boundary',
  };
}

function createPathResolutionTransitionObserver() {
  return Object.freeze({
    id: PATH_RESOLUTION_OBSERVER_ID,
    schemaVersion: 1,
    evidenceType: 'filesystem.path-resolution-transition',
    toolName: PATH_PROBE_TOOL,
    reviewerPrompt: REVIEWER_PATH_PROBE_PROMPT,
    auditorPrompt: REVIEW_AUDITOR_BOUNDARY_PROMPT,
    metadata: Object.freeze({
      oracleBlind: true,
      revisionBound: true,
      typedTransitions: true,
      repositoryWrites: false,
    }),
    applicability(context) {
      return pathResolutionObserverApplicability(context);
    },
    createTool({ defineTool, workspace, observationSink }) {
      return createPathResolutionProbeTool(defineTool, { workspace, observationSink });
    },
    compactEvidence(observations, revision) {
      return compactProbeEvidence(observations, revision);
    },
    augmentReview(review, evidence, revision) {
      return augmentReviewWithProgrammaticProbeEvidence(review, evidence, revision);
    },
  });
}

function validateObserver(observer) {
  if (!observer || typeof observer !== 'object') throw new Error('Evidence observer must be an object.');
  if (!String(observer.id ?? '').trim()) throw new Error('Evidence observer requires a stable id.');
  if (!String(observer.evidenceType ?? '').trim()) throw new Error(`Evidence observer ${observer.id} requires evidenceType.`);
  if (!String(observer.toolName ?? '').trim()) throw new Error(`Evidence observer ${observer.id} requires toolName.`);
  if (typeof observer.applicability !== 'function') throw new Error(`Evidence observer ${observer.id} requires applicability().`);
  if (typeof observer.createTool !== 'function') throw new Error(`Evidence observer ${observer.id} requires createTool().`);
  if (typeof observer.compactEvidence !== 'function') throw new Error(`Evidence observer ${observer.id} requires compactEvidence().`);
  if (typeof observer.augmentReview !== 'function') throw new Error(`Evidence observer ${observer.id} requires augmentReview().`);
  return observer;
}

function normalizeApplicability(observer, value) {
  if (value === true) return { observerId: observer.id, applicable: true, reason: 'observer-declared-applicable' };
  if (value === false || value == null) return { observerId: observer.id, applicable: false, reason: 'observer-declared-not-applicable' };
  if (typeof value !== 'object') {
    return { observerId: observer.id, applicable: false, reason: 'invalid-applicability-result' };
  }
  return {
    observerId: observer.id,
    applicable: value.applicable === true,
    reason: String(value.reason ?? (value.applicable === true ? 'observer-declared-applicable' : 'observer-declared-not-applicable')).slice(0, 240),
  };
}

class EvidenceObserverRegistry {
  constructor(observers = []) {
    this.observers = (Array.isArray(observers) ? observers : []).map(validateObserver);
    const ids = new Set();
    for (const observer of this.observers) {
      if (ids.has(observer.id)) throw new Error(`Duplicate evidence observer id: ${observer.id}`);
      ids.add(observer.id);
    }
  }

  evaluateApplicability(context = {}) {
    return this.observers.map((observer) => {
      try {
        return normalizeApplicability(observer, observer.applicability(context));
      } catch (error) {
        return {
          observerId: observer.id,
          applicable: false,
          reason: `applicability-error:${String(error?.message ?? error).slice(0, 200)}`,
        };
      }
    });
  }

  selectApplicable(context = {}) {
    const decisions = this.evaluateApplicability(context);
    const applicableIds = new Set(decisions.filter((entry) => entry.applicable).map((entry) => entry.observerId));
    return {
      registry: new EvidenceObserverRegistry(this.observers.filter((observer) => applicableIds.has(observer.id))),
      decisions,
    };
  }

  createObservationState() {
    return new Map(this.observers.map((observer) => [observer.id, []]));
  }

  injectReviewerClient(baseClient, factory, observationState) {
    if (!this.observers.length) return baseClient;
    const tools = this.observers.map((observer) => observer.createTool({
      defineTool: factory.sdk.defineTool,
      workspace: factory.workspace,
      workspaceFolders: factory.workspaceFolders,
      observationSink: observationState.get(observer.id),
    }));
    const prompts = this.observers.map((observer) => observer.reviewerPrompt).filter(Boolean);
    const toolNames = this.observers.map((observer) => observer.toolName);
    const proxy = Object.create(baseClient);
    proxy.createSession = async (options = {}) => {
      const originalPrompt = options.systemMessage?.content ?? '';
      return baseClient.createSession({
        ...options,
        tools: [...(options.tools ?? []), ...tools],
        availableTools: [...new Set([...(options.availableTools ?? []), ...toolNames])],
        systemMessage: {
          mode: 'append',
          content: [originalPrompt, ...prompts].filter(Boolean).join('\n\n'),
        },
      });
    };
    return proxy;
  }

  auditorPrompt() {
    return this.observers.map((observer) => observer.auditorPrompt).filter(Boolean).join('\n\n');
  }

  evidenceForRevision(observationState, revision) {
    return this.observers.map((observer) => ({
      observerId: observer.id,
      schemaVersion: observer.schemaVersion ?? 1,
      evidenceType: observer.evidenceType,
      observations: observer.compactEvidence(observationState.get(observer.id) ?? [], revision),
    }));
  }

  augmentReview(review, observationState, revision) {
    let augmented = review;
    const packets = this.evidenceForRevision(observationState, revision);
    for (let index = 0; index < this.observers.length; index += 1) {
      const observer = this.observers[index];
      augmented = observer.augmentReview(augmented, packets[index].observations, revision);
    }
    return { review: augmented, packets };
  }

  metadata() {
    return this.observers.map((observer) => ({
      id: observer.id,
      schemaVersion: observer.schemaVersion ?? 1,
      evidenceType: observer.evidenceType,
      toolName: observer.toolName,
      ...(observer.metadata ?? {}),
    }));
  }
}

module.exports = {
  MAX_AUDITOR_PROBE_OBSERVATIONS,
  PATH_RESOLUTION_OBSERVER_ID,
  REVIEW_AUDITOR_BOUNDARY_PROMPT,
  injectSystemPromptIntoClient,
  compactProbeEvidence,
  augmentReviewWithProgrammaticProbeEvidence,
  taskContractText,
  pathResolutionObserverApplicability,
  createPathResolutionTransitionObserver,
  validateObserver,
  normalizeApplicability,
  EvidenceObserverRegistry,
};
