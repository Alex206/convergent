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

const REVIEW_AUDITOR_BOUNDARY_PROMPT = `
Apply the evidence contract especially strictly at acceptance-rule boundaries.

Derive the semantic distinctions from the TASK CONTRACT before judging the review report. When the task contains both a permissive rule and a restrictive rule over closely related transformations, a claimed matched hostile/benign pair is adequate only if:
- the negative witness exercises the restrictive rule at its boundary;
- the positive witness exercises the permissive rule at its boundary, not merely an easier happy path;
- both observations stress the same controversial intermediate state or transition family as far as the task semantics permit;
- the pair holds irrelevant dimensions as constant as practical and varies the contract property that explains why one must reject while the other must accept;
- the positive witness would actually fail under the plausible over-restrictive remediation suggested by the negative finding.

If the report proves only that some ordinary valid case still works, but does not test the edge of the task's stated permissive rule, set overrestriction_guard=false and matched_contrast_pair=false. Do not invent a hidden test case; derive the needed semantic boundary only from the supplied task contract and the review report.
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

class ProbeEnabledReviewEvidenceAuditorSessionFactory extends ReviewEvidenceAuditorSessionFactory {
  async createReviewer(...args) {
    const probeTool = createPathResolutionProbeTool(this.sdk.defineTool, {
      workspace: this.workspace,
    });
    const baseClient = this.client;
    this.client = injectPathProbeIntoReviewerClient(this, baseClient, probeTool);
    try {
      return await super.createReviewer(...args);
    } finally {
      this.client = baseClient;
    }
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
  REVIEW_AUDITOR_BOUNDARY_PROMPT,
  injectSystemPromptIntoClient,
  ProbeEnabledReviewEvidenceAuditorSessionFactory,
  EnvironmentConfiguredReviewAuditorEngine,
  rewriteExperimentIdentity,
  main,
};
