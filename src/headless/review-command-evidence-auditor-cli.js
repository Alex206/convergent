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
  captureReviewerCommandEvidence,
  compactReviewerCommandEvidence,
} = require('./reviewer-command-evidence');

const REVIEWER_COMMAND_EVIDENCE_PROMPT = `
For high-risk review, use run_command when concrete performed evidence is needed to establish a correctness, compatibility, or trust-boundary claim. Convergent captures your actual managed-command invocation and bounded result automatically and binds it to the exact workspace revision for a later independent evidence audit.

Prefer existing focused tests when they directly discriminate the requirement. When an ad-hoc diagnostic is necessary, keep it small, read-only with respect to the repository, and make it exercise the actual implementation rather than merely echoing or reconstructing an expected answer. Temporary fixtures should live outside the repository where practical. Print concrete raw inputs and observed outcomes that another reviewer can interpret from the command itself and its result.

For a transformation or provenance boundary, do not validate only easy endpoints. Exercise a hostile and benign contrast at the controversial semantic boundary. If a later transformation can mask an earlier forbidden transition, the hostile witness must actually exercise that transition and converge to an otherwise plausible final state. The benign witness must be close enough to falsify an over-restrictive remediation; only the security-relevant condition should differ materially.

Your final report_review must explain the invariant and identify which performed command evidence supports the CLEAN conclusion. Do not claim an observation that the captured command/result does not demonstrate.
`.trim();

const REVIEW_AUDITOR_COMMAND_EVIDENCE_PROMPT = `
The strong review report can contain a PROGRAMMATIC COMMAND EVIDENCE entry. It is a bounded capture of actual run_command invocations and managed results performed by the strong reviewer on the exact workspace revision being approved. The capture is authoritative evidence that those commands ran with those inputs and produced those outputs; it is not an oracle and the command's own assertions are not automatically true.

Judge the evidence from the TASK CONTRACT, command text, exit/result metadata, and concrete stdout/stderr. Reject a claimed witness when the command merely echoes an expected answer, hard-codes the semantic conclusion instead of exercising the implementation, hides the decisive input/result, is stale for another revision, or does not actually discriminate the claimed boundary.

For a high-risk transformation/provenance invariant, a CLEAN report is adequate only when current-revision performed evidence is sufficient to distinguish the restrictive rule from the corresponding permissive rule. When final-state masking is relevant, the hostile observation must exercise the forbidden intermediate transition before converging to an otherwise acceptable-looking final state. The benign observation must exercise the corresponding permitted transition closely enough that it would fail under a plausible over-restrictive remediation. The security-relevant condition should be the material difference.

Do not demand a particular language, command, hidden test, path spelling, or implementation. Different commands are valid if their actual invocation/results demonstrate the required semantics. Keep repository access off: assess only the bounded task contract, structured review, and captured command evidence.
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

function augmentReviewWithProgrammaticCommandEvidence(review, commandEvidence, revision) {
  const checks = Array.isArray(review?.checks) ? review.checks : [];
  const payload = {
    workspace_revision: String(revision ?? '').slice(0, 16),
    source: 'captured reviewer run_command invocations/results on this exact revision',
    observations: commandEvidence,
  };
  return {
    ...review,
    checks: [
      ...checks,
      `PROGRAMMATIC COMMAND EVIDENCE (authoritative execution record; current revision only): ${JSON.stringify(payload)}`,
    ],
  };
}

class CommandEvidenceReviewAuditorSessionFactory extends ReviewEvidenceAuditorSessionFactory {
  constructor(options = {}) {
    super(options);
    this.reviewCommandEvidence = [];
    this.reviewCommandCapture = null;
  }

  async createReviewer(...args) {
    const baseClient = this.client;
    this.client = injectSystemPromptIntoClient(baseClient, REVIEWER_COMMAND_EVIDENCE_PROMPT);
    try {
      const reviewer = await super.createReviewer(...args);
      this.reviewCommandCapture?.dispose?.();
      this.reviewCommandCapture = captureReviewerCommandEvidence(reviewer.session, {
        workspace: this.workspace,
        workspaceFolders: this.workspaceFolders,
        sink: this.reviewCommandEvidence,
      });
      return reviewer;
    } finally {
      this.client = baseClient;
    }
  }

  async reviewCommandEvidenceForRevision(revision) {
    await this.reviewCommandCapture?.flush?.();
    return compactReviewerCommandEvidence(this.reviewCommandEvidence, revision);
  }

  async createReviewEvidenceAuditor(...args) {
    const baseClient = this.client;
    this.client = injectSystemPromptIntoClient(baseClient, REVIEW_AUDITOR_COMMAND_EVIDENCE_PROMPT);
    try {
      return await super.createReviewEvidenceAuditor(...args);
    } finally {
      this.client = baseClient;
    }
  }
}

class EnvironmentConfiguredCommandEvidenceEngine extends ReviewEvidenceAuditorBenchmarkEngine {
  constructor(options = {}) {
    const auditorSelector = String(process.env.CONVERGENT_REVIEW_EVIDENCE_AUDITOR_MODEL ?? 'gpt-5.6-luna').trim();
    const experimentTopology = String(process.env.CONVERGENT_REVIEW_EVIDENCE_AUDITOR_TOPOLOGY ?? `review-audit-${auditorSelector}-command-evidence`).trim();
    super({
      ...options,
      reviewAuditorSelector: auditorSelector,
      experimentTopology,
    });
  }

  sessionFactory() {
    return new CommandEvidenceReviewAuditorSessionFactory({
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
    const commandEvidence = await factory.reviewCommandEvidenceForRevision?.(revision) ?? [];
    const augmentedReview = augmentReviewWithProgrammaticCommandEvidence(review, commandEvidence, revision);
    this.ui?.audit?.({
      type: 'benchmark_review_command_evidence_packet',
      topology: this.experimentTopology,
      taskId: task.id,
      round,
      revision,
      commandEvidence,
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
// the export before requiring topology-runner/topology-cli so the experiment
// engine cannot be replaced by the normal benchmark engine through module cache.
topologyEngineModule.BenchmarkTopologyEngine = EnvironmentConfiguredCommandEvidenceEngine;
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
  result.topologyLabel = `Luna + Terra review + low-context ${auditorSelector} command-evidence audit`;
  result.reviewEvidenceAuditor = {
    selector: auditorSelector,
    lowContext: true,
    repositoryTools: false,
    authoritativeCommandEvidence: true,
    revisionBoundCommandEvidence: true,
    domainSpecificProbe: false,
  };
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const metaPath = path.join(outputDir, 'review-command-evidence-auditor-meta.json');
  await fs.writeFile(metaPath, `${JSON.stringify({
    experimentTopology,
    auditorSelector,
    lowContext: true,
    repositoryTools: false,
    authoritativeCommandEvidence: true,
    revisionBoundCommandEvidence: true,
    domainSpecificProbe: false,
  }, null, 2)}\n`, 'utf8');
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const auditorSelector = String(process.env.CONVERGENT_REVIEW_EVIDENCE_AUDITOR_MODEL ?? 'gpt-5.6-luna').trim();
  const experimentTopology = String(process.env.CONVERGENT_REVIEW_EVIDENCE_AUDITOR_TOPOLOGY ?? `review-audit-${auditorSelector}-command-evidence`).trim();

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
  REVIEWER_COMMAND_EVIDENCE_PROMPT,
  REVIEW_AUDITOR_COMMAND_EVIDENCE_PROMPT,
  injectSystemPromptIntoClient,
  augmentReviewWithProgrammaticCommandEvidence,
  CommandEvidenceReviewAuditorSessionFactory,
  EnvironmentConfiguredCommandEvidenceEngine,
  rewriteExperimentIdentity,
  main,
};
