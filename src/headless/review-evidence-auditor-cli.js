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
  MAX_AUDITOR_PROBE_OBSERVATIONS,
  REVIEW_AUDITOR_BOUNDARY_PROMPT,
  injectSystemPromptIntoClient,
  compactProbeEvidence,
  augmentReviewWithProgrammaticProbeEvidence,
  createPathResolutionTransitionObserver,
  EvidenceObserverRegistry,
} = require('./evidence-observers');
const {
  createDependencyOrderEvidenceObserver,
} = require('./dependency-order-evidence-observer');

const WORKER_TYPED_EVIDENCE_AID_PROMPT = `
IMPLEMENTER TYPED-EVIDENCE AID (benchmark only):
You may use the selected read-only typed evidence probe while implementing to falsify your own design against the task contract before reporting CHANGED. The probe is an oracle-blind diagnostic, not an acceptance oracle and not approval evidence.

Use it only when it helps distinguish a semantic boundary that ordinary tests or final-state inspection could miss. Derive witnesses from the task contract and actual implementation; do not assume hidden expected cases. Observer-specific guidance below may use reviewer terminology because the same capability is shared with the independent reviewer. As Worker A, treat that guidance only as instructions for choosing discriminating self-checks and still finish with report_pass.

Your probe observations are isolated from the strong review evidence packet. The independent reviewer must execute and explain its own current-revision evidence before CLEAN can be approved.
`.trim();

function envFlag(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function createDefaultEvidenceObserverRegistry() {
  return new EvidenceObserverRegistry([
    createPathResolutionTransitionObserver(),
    createDependencyOrderEvidenceObserver(),
  ]);
}

class ProbeEnabledReviewEvidenceAuditorSessionFactory extends ReviewEvidenceAuditorSessionFactory {
  constructor(options = {}) {
    super(options);
    this.defaultReviewAuditContract = this.reviewAuditContract;
    this.availableEvidenceObservers = options.evidenceObservers ?? createDefaultEvidenceObserverRegistry();
    this.evidenceObservers = new EvidenceObserverRegistry([]);
    this.evidenceObservationState = this.evidenceObservers.createObservationState();
    this.workerEvidenceAid = options.workerEvidenceAid === true;
    this.workerEvidenceObservationState = this.evidenceObservers.createObservationState();
    this.evidenceObserverApplicability = [];
  }

  configureEvidenceObservers(context = {}) {
    const selected = this.availableEvidenceObservers.selectApplicable(context);
    this.evidenceObservers = selected.registry;
    this.evidenceObservationState = this.evidenceObservers.createObservationState();
    this.workerEvidenceObservationState = this.evidenceObservers.createObservationState();
    this.evidenceObserverApplicability = selected.decisions;
    this.reviewAuditContract = this.evidenceObservers.auditContract() ?? this.defaultReviewAuditContract;
    return selected.decisions;
  }

  workerEvidenceAidClient(baseClient) {
    const withObserverTools = this.evidenceObservers.injectReviewerClient(
      baseClient,
      this,
      this.workerEvidenceObservationState,
    );
    return injectSystemPromptIntoClient(withObserverTools, WORKER_TYPED_EVIDENCE_AID_PROMPT);
  }

  async createWorker(...args) {
    const worker = args[1];
    if (!this.workerEvidenceAid || worker !== 'A' || !this.evidenceObservers.metadata().length) {
      return super.createWorker(...args);
    }
    const baseClient = this.client;
    this.client = this.workerEvidenceAidClient(baseClient);
    try {
      return await super.createWorker(...args);
    } finally {
      this.client = baseClient;
    }
  }

  async createReviewer(...args) {
    const baseClient = this.client;
    this.client = this.evidenceObservers.injectReviewerClient(
      baseClient,
      this,
      this.evidenceObservationState,
    );
    try {
      return await super.createReviewer(...args);
    } finally {
      this.client = baseClient;
    }
  }

  observerEvidenceForRevision(revision) {
    return this.evidenceObservers.evidenceForRevision(this.evidenceObservationState, revision);
  }

  workerObserverEvidenceForRevision(revision) {
    return this.evidenceObservers.evidenceForRevision(this.workerEvidenceObservationState, revision);
  }

  // Compatibility accessor retained for the existing path benchmark tests while
  // the active experiment is selected through the generic observer registry.
  reviewProbeEvidenceForRevision(revision) {
    return this.observerEvidenceForRevision(revision)[0]?.observations ?? [];
  }

  augmentReviewWithObserverEvidence(review, revision) {
    return this.evidenceObservers.augmentReview(review, this.evidenceObservationState, revision);
  }

  async createReviewEvidenceAuditor(...args) {
    const baseClient = this.client;
    this.client = injectSystemPromptIntoClient(baseClient, this.evidenceObservers.auditorPrompt());
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
    this.workerEvidenceAid = envFlag(process.env.CONVERGENT_WORKER_TYPED_EVIDENCE_AID);
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
      evidenceObservers: createDefaultEvidenceObserverRegistry(),
      workerEvidenceAid: this.workerEvidenceAid,
    });
  }

  async runFullTask(factory, task, taskSessionKey, routing, taskResumeState = null) {
    const applicability = factory.configureEvidenceObservers?.({ task, routing }) ?? [];
    const selected = factory.evidenceObservers?.metadata?.() ?? [];
    this.ui?.audit?.({
      type: 'benchmark_evidence_observer_selection',
      topology: this.experimentTopology,
      taskId: task.id,
      route: routing.route,
      risk: routing.risk,
      applicability,
      selectedObservers: selected,
      auditContract: factory.reviewAuditContract?.id ?? null,
      workerEvidenceAid: factory.workerEvidenceAid === true,
      workerEvidenceAuthoritativeForReview: false,
    });
    if (!selected.length) {
      throw new Error('Typed-evidence benchmark has no applicable observer; fail closed rather than silently weakening assurance.');
    }
    return super.runFullTask(factory, task, taskSessionKey, routing, taskResumeState);
  }

  async runReviewEvidenceAudit(factory, task, taskSessionKey, routing, review, round) {
    const revision = await this.revisionProvider(this.workspace, this.workspaceFolders);
    const packet = factory.augmentReviewWithObserverEvidence?.(review, revision) ?? {
      review,
      packets: [],
    };
    const compatibilityEvidence = packet.packets[0]?.observations ?? [];
    const workerEvidence = factory.workerObserverEvidenceForRevision?.(revision) ?? [];
    this.ui?.audit?.({
      type: 'benchmark_review_typed_evidence_packet',
      topology: this.experimentTopology,
      taskId: task.id,
      round,
      revision,
      probeEvidence: compatibilityEvidence,
      observerEvidence: packet.packets,
      workerObserverEvidence: workerEvidence,
      workerEvidenceAuthoritativeForReview: false,
      auditContract: factory.reviewAuditContract?.id ?? null,
    });
    return super.runReviewEvidenceAudit(
      factory,
      task,
      taskSessionKey,
      routing,
      packet.review,
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

async function rewriteExperimentIdentity(outputDir, experimentTopology, auditorSelector, workerEvidenceAid = false) {
  const resultPath = path.join(outputDir, 'result.json');
  let result;
  try {
    result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  } catch {
    return false;
  }
  const observerMetadata = createDefaultEvidenceObserverRegistry().metadata();
  result.topology = experimentTopology;
  result.topologyLabel = workerEvidenceAid
    ? `Luna with typed self-check + Terra review + low-context ${auditorSelector} typed-evidence audit`
    : `Luna + Terra review + low-context ${auditorSelector} typed-evidence audit`;
  result.reviewEvidenceAuditor = {
    selector: auditorSelector,
    lowContext: true,
    repositoryTools: false,
    availableTypedEvidenceObservers: observerMetadata,
    auditContractSelection: 'selected-observer-contract',
    observerSelection: 'explicit-fail-closed',
    authoritativeEvidence: true,
    revisionBoundEvidence: true,
    workerTypedEvidenceAid: workerEvidenceAid,
    workerEvidenceAuthoritativeForReview: false,
  };
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const metaPath = path.join(outputDir, 'review-evidence-auditor-meta.json');
  await fs.writeFile(metaPath, `${JSON.stringify({
    experimentTopology,
    auditorSelector,
    lowContext: true,
    repositoryTools: false,
    availableTypedEvidenceObservers: observerMetadata,
    auditContractSelection: 'selected-observer-contract',
    observerSelection: 'explicit-fail-closed',
    authoritativeEvidence: true,
    revisionBoundEvidence: true,
    workerTypedEvidenceAid: workerEvidenceAid,
    workerEvidenceAuthoritativeForReview: false,
  }, null, 2)}\n`, 'utf8');
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const auditorSelector = String(process.env.CONVERGENT_REVIEW_EVIDENCE_AUDITOR_MODEL ?? 'gpt-5.6-luna').trim();
  const experimentTopology = String(process.env.CONVERGENT_REVIEW_EVIDENCE_AUDITOR_TOPOLOGY ?? `review-audit-${auditorSelector}`).trim();
  const workerEvidenceAid = envFlag(process.env.CONVERGENT_WORKER_TYPED_EVIDENCE_AID);

  options.topology = 'luna-terra-structured';
  let failure = null;
  try {
    await runWithStartupRetry(options, runTopologyHeadless);
  } catch (error) {
    failure = error;
  } finally {
    await rewriteExperimentIdentity(options.outputDir, experimentTopology, auditorSelector, workerEvidenceAid);
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
  WORKER_TYPED_EVIDENCE_AID_PROMPT,
  envFlag,
  injectSystemPromptIntoClient,
  compactProbeEvidence,
  augmentReviewWithProgrammaticProbeEvidence,
  createDefaultEvidenceObserverRegistry,
  ProbeEnabledReviewEvidenceAuditorSessionFactory,
  EnvironmentConfiguredReviewAuditorEngine,
  rewriteExperimentIdentity,
  main,
};
