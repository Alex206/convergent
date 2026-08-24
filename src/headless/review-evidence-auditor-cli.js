#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('./runner');
const topologyEngineModule = require('./topology-engine');
const {
  ReviewEvidenceAuditorBenchmarkEngine,
  ReviewEvidenceAuditorSessionFactory,
} = require('./review-evidence-auditor');
const {
  createPathResolutionProbeTool,
  injectPathProbeIntoReviewerClient,
} = require('./reviewer-path-probe');

const MAX_AUDITOR_PROBE_OBSERVATIONS = 4;
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

class ProbeEnabledReviewEvidenceAuditorSessionFactory extends ReviewEvidenceAuditorSessionFactory {
  constructor(options = {}) {
    super(options);
    this.reviewProbeObservations = [];
  }

  async createReviewer(...args) {
    const probeTool = createPathResolutionProbeTool(this.sdk.defineTool, {
      workspace: this.workspace,
      observationSink: this.reviewProbeObservations,
    });
    const baseClient = this.client;
    this.client = injectPathProbeIntoReviewerClient(this, baseClient, probeTool);
    try {
      return await super.createReviewer(...args);
    } finally {
      this.client = baseClient;
    }
  }

  reviewProbeEvidenceForRevision(revision) {
    return compactProbeEvidence(this.reviewProbeObservations, revision);
  }

  async createReviewEvidenceAuditor(...args) {
    const baseClient = this.client;
    this.client = injectSystemPromptIntoClient(baseClient, REVIEW_AUDITOR_BOUNDARY_PROMPT);
    try {
      return await super.createReviewEvidenceAuditor(...args);
    } finally {
      this.client = baseClient;
    }
  }
}

class EnvironmentConfiguredReviewAuditorEngine extends ReviewEvidenceAuditorBenchmarkEngine {
  constructor(options = {}) {
    const auditorSelector = String(process.env.CONVERGENT_REVIEW_EVIDENCE_AUDITOR_MODEL ?? 'gpt-5.6-luna').trim();
    const experimentTopology = String(process.env.CONVERGENT_REVIEW_EVIDENCE_AUDITOR_TOPOLOGY ?? `review-audit-${auditorSelector}`).trim();
    super({
      ...options,
      reviewAuditorSelector: auditorSelector,
      experimentTopology,
    });
  }

  sessionFactory() {
    return new ProbeEnabledReviewEvidenceAuditorSessionFactory({
      client: this.client,
      sdk: this.sdk,
      workspace: this.workspace,
      workspaceFolders: this.workspaceFolders,
      models: this.models,
      permissionHandler: this.permissionHandler,
      userInputHandler: this.userInputHandler,
      ui: this.ui,
      usage: this.usage,
      runId: this.runId,
      reasoningMode: this.reasoningMode,
      operatorCredentialGuard: this.operatorCredentialGuard,
      reviewAuditorSelector: this.reviewAuditorSelector,
    });
  }

  async runReviewEvidenceAudit(factory, task, taskSessionKey, routing, review, round) {
    const revision = await this.revisionProvider(this.workspace, this.workspaceFolders);
    const probeEvidence = factory.reviewProbeEvidenceForRevision?.(revision) ?? [];
    const augmentedReview = augmentReviewWithProgrammaticProbeEvidence(review, probeEvidence, revision);
    this.ui?.audit?.({
      type: 'benchmark_review_probe_evidence_packet',
      topology: this.experimentTopology,
      taskId: task.id,
      round,
      revision,
      probeEvidence,
    });
    return super.runReviewEvidenceAudit(
      factory,
      task,
      taskSessionKey,
      routing,
      augmentedReview,
      round,
    );
  }
}

// topology-runner destructures BenchmarkTopologyEngine when it is loaded. Patch
// the export first so Node's module cache cannot freeze the normal benchmark
// engine into this experiment before the low-context auditor engine is active.
topologyEngineModule.BenchmarkTopologyEngine = EnvironmentConfiguredReviewAuditorEngine;
const { runTopologyHeadless } = require('./topology-runner');
const { runWithStartupRetry } = require('./topology-cli');

async function rewriteExperimentIdentity(outputDir, experimentTopology, auditorSelector) {
  const resultPath = path.join(outputDir, 'result.json');
  let result;
  try {
    result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  } catch {
    return false;
  }
  result.topology = experimentTopology;
  result.topologyLabel = `Luna + Terra review + low-context ${auditorSelector} evidence audit`;
  result.reviewEvidenceAuditor = {
    selector: auditorSelector,
    lowContext: true,
    repositoryTools: false,
    reviewerIsolatedPathProbe: true,
    positiveBoundaryEvidence: true,
    authoritativeProbeEvidence: true,
    revisionBoundProbeEvidence: true,
  };
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const metaPath = path.join(outputDir, 'review-evidence-auditor-meta.json');
  await fs.writeFile(metaPath, `${JSON.stringify({
    experimentTopology,
    auditorSelector,
    lowContext: true,
    repositoryTools: false,
    reviewerIsolatedPathProbe: true,
    positiveBoundaryEvidence: true,
    authoritativeProbeEvidence: true,
    revisionBoundProbeEvidence: true,
  }, null, 2)}\n`, 'utf8');
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const auditorSelector = String(process.env.CONVERGENT_REVIEW_EVIDENCE_AUDITOR_MODEL ?? 'gpt-5.6-luna').trim();
  const experimentTopology = String(process.env.CONVERGENT_REVIEW_EVIDENCE_AUDITOR_TOPOLOGY ?? `review-audit-${auditorSelector}`).trim();

  options.topology = 'luna-terra-structured';
  let failure = null;
  try {
    await runWithStartupRetry(options, runTopologyHeadless);
  } catch (error) {
    failure = error;
  } finally {
    await rewriteExperimentIdentity(options.outputDir, experimentTopology, auditorSelector);
  }
  if (failure) throw failure;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_AUDITOR_PROBE_OBSERVATIONS,
  REVIEW_AUDITOR_BOUNDARY_PROMPT,
  injectSystemPromptIntoClient,
  compactProbeEvidence,
  augmentReviewWithProgrammaticProbeEvidence,
  ProbeEnabledReviewEvidenceAuditorSessionFactory,
  EnvironmentConfiguredReviewAuditorEngine,
  rewriteExperimentIdentity,
  main,
};