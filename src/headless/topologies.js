'use strict';

const { assertGitRepository } = require('../orchestrator/revision');
const { routePolicy } = require('../orchestrator/routing');
const {
  requireReport,
  taskPrompt,
  evidenceFromPass,
  formatValidationEvidence,
} = require('../orchestrator/engine');
const {
  RecoveryConvergentEngine,
  queueRecoveryInstruction,
} = require('../orchestrator/recovery-engine');
const { formatTaskChangeManifest } = require('../orchestrator/task-change-manifest');
const { ExperimentalSessionFactory } = require('./experimental-session-factory');
const {
  OperatorCredentialGuard,
  reconcileCredentialIntegrityReport,
} = require('./operator-credential-guard');

const ARCHITECTURES = Object.freeze({
  SINGLE_AGENT: 'single-agent',
  IMPLEMENTER_REVIEWER: 'implementer-reviewer',
  PEER_COMPETITION: 'peer-competition',
  PEER_COMPETITION_REVIEWER: 'peer-competition-reviewer',
  CONVERGENT_V02: 'convergent-v02',
});

const RECOVERY_POLICIES = Object.freeze({
  NONE: 'none',
  STRONG_COORDINATOR: 'strong-coordinator',
});

const VALID_ARCHITECTURES = new Set(Object.values(ARCHITECTURES));
const VALID_RECOVERY_POLICIES = new Set(Object.values(RECOVERY_POLICIES));

function normalizeArchitecture(value) {
  const normalized = String(value ?? ARCHITECTURES.CONVERGENT_V02).trim().toLowerCase();
  const aliases = {
    current: ARCHITECTURES.CONVERGENT_V02,
    convergent: ARCHITECTURES.CONVERGENT_V02,
    '0.2': ARCHITECTURES.CONVERGENT_V02,
    single: ARCHITECTURES.SINGLE_AGENT,
    reviewer: ARCHITECTURES.IMPLEMENTER_REVIEWER,
    'implementer+reviewer': ARCHITECTURES.IMPLEMENTER_REVIEWER,
    peers: ARCHITECTURES.PEER_COMPETITION,
    'two-peers': ARCHITECTURES.PEER_COMPETITION,
    'terra-vs-terra': ARCHITECTURES.PEER_COMPETITION,
    'peers+reviewer': ARCHITECTURES.PEER_COMPETITION_REVIEWER,
    'two-peers-reviewer': ARCHITECTURES.PEER_COMPETITION_REVIEWER,
  };
  const resolved = aliases[normalized] ?? normalized;
  if (!VALID_ARCHITECTURES.has(resolved)) {
    throw new Error(`Unsupported benchmark architecture: ${value}. Expected one of: ${[...VALID_ARCHITECTURES].join(', ')}`);
  }
  return resolved;
}

function normalizeRecoveryPolicy(value) {
  const normalized = String(value ?? RECOVERY_POLICIES.NONE).trim().toLowerCase();
  const aliases = {
    off: RECOVERY_POLICIES.NONE,
    disabled: RECOVERY_POLICIES.NONE,
    strong: RECOVERY_POLICIES.STRONG_COORDINATOR,
    coordinator: RECOVERY_POLICIES.STRONG_COORDINATOR,
    'on-demand': RECOVERY_POLICIES.STRONG_COORDINATOR,
  };
  const resolved = aliases[normalized] ?? normalized;
  if (!VALID_RECOVERY_POLICIES.has(resolved)) {
    throw new Error(`Unsupported recovery policy: ${value}. Expected one of: ${[...VALID_RECOVERY_POLICIES].join(', ')}`);
  }
  return resolved;
}

function architectureMetadata(architecture, options = {}) {
  const id = normalizeArchitecture(architecture);
  const recoveryPolicy = normalizeRecoveryPolicy(options.recoveryPolicy);
  const recovery = {
    recoveryPolicy,
    conditionalRoles: recoveryPolicy === RECOVERY_POLICIES.STRONG_COORDINATOR
      ? ['strong-recovery-coordinator']
      : [],
  };
  if (id === ARCHITECTURES.SINGLE_AGENT) {
    return {
      id,
      topology: 'implementer',
      activeRoles: ['implementer'],
      selectors: { implementer: options.workerA ?? 'adaptive' },
      independentReviewer: false,
      peerConvergence: false,
      coordinator: false,
      ...recovery,
    };
  }
  if (id === ARCHITECTURES.IMPLEMENTER_REVIEWER) {
    return {
      id,
      topology: 'implementer -> strong reviewer -> bounded remediation',
      activeRoles: ['implementer', 'strong-reviewer'],
      selectors: {
        implementer: options.workerA ?? 'adaptive',
        reviewer: options.reviewer ?? 'strong',
      },
      independentReviewer: true,
      peerConvergence: false,
      coordinator: false,
      ...recovery,
    };
  }
  if (id === ARCHITECTURES.PEER_COMPETITION || id === ARCHITECTURES.PEER_COMPETITION_REVIEWER) {
    const withReviewer = id === ARCHITECTURES.PEER_COMPETITION_REVIEWER;
    return {
      id,
      topology: withReviewer
        ? 'Worker A <-> Worker B exact-fingerprint convergence -> strong reviewer'
        : 'Worker A <-> Worker B exact-fingerprint convergence',
      activeRoles: withReviewer
        ? ['worker-a', 'worker-b', 'strong-reviewer']
        : ['worker-a', 'worker-b'],
      selectors: {
        workerA: options.workerA ?? 'strong',
        workerB: options.workerB ?? 'strong',
        ...(withReviewer ? { reviewer: options.reviewer ?? 'strong' } : {}),
      },
      independentReviewer: withReviewer,
      peerConvergence: true,
      coordinator: false,
      ...recovery,
    };
  }
  return {
    id,
    topology: 'strong coordinator -> Worker A/B convergence -> strong reviewer',
    activeRoles: ['coordinator', 'worker-a', 'worker-b', 'strong-reviewer'],
    selectors: {
      coordinator: options.coordinator ?? 'strong',
      workerA: options.workerA ?? 'adaptive',
      workerB: options.workerB ?? 'adaptive-diverse',
      reviewer: options.reviewer ?? 'strong',
    },
    independentReviewer: true,
    peerConvergence: true,
    coordinator: true,
    recoveryPolicy: RECOVERY_POLICIES.STRONG_COORDINATOR,
    conditionalRoles: ['strong-recovery-coordinator'],
  };
}

function benchmarkTask(prompt, { route = 'standard', risk = 'medium' } = {}) {
  return {
    id: 'benchmark-task',
    title: 'Benchmark request',
    description: String(prompt ?? '').trim(),
    acceptanceCriteria: [
      'Satisfy every explicit requirement in the benchmark request, including validation and non-regression constraints.',
    ],
    route,
    risk,
    routingReason: 'Experimental topology benchmark uses one fixed task so topology, rather than coordinator decomposition, is the independent variable.',
    inspectionHints: [],
  };
}

class ExperimentalTopologyEngine extends RecoveryConvergentEngine {
  constructor(options = {}) {
    super(options);
    this.architecture = normalizeArchitecture(options.architecture);
    this.recoveryPolicy = normalizeRecoveryPolicy(options.recoveryPolicy);
    this.maxExperimentalRecoveryAttempts = Math.max(1, Number(options.maxExperimentalRecoveryAttempts) || 2);
    this.experimentalRoute = options.experimentalRoute ?? 'standard';
    this.experimentalRisk = options.experimentalRisk ?? 'medium';
    this.operatorCredentialGuard = new OperatorCredentialGuard({
      environment: options.environment ?? process.env,
    });
    if (
      this.recoveryPolicy !== RECOVERY_POLICIES.NONE
      && [ARCHITECTURES.PEER_COMPETITION, ARCHITECTURES.PEER_COMPETITION_REVIEWER].includes(this.architecture)
    ) {
      throw new Error('On-demand recovery is not yet implemented for peer-competition experimental topologies; benchmark it only with recovery=none until a peer-recovery policy is defined.');
    }
  }

  async validateWorkspace() {
    await assertGitRepository(this.workspace);
  }

  createFactory() {
    return new ExperimentalSessionFactory({
      client: this.client,
      sdk: this.sdk,
      workspace: this.workspace,
      models: this.models,
      permissionHandler: this.permissionHandler,
      userInputHandler: this.userInputHandler,
      ui: this.ui,
      usage: this.usage,
      runId: this.runId,
      reasoningMode: this.reasoningMode,
      operatorCredentialGuard: this.operatorCredentialGuard,
    });
  }

  async consultRecoveryCoordinator(...args) {
    const decision = await super.consultRecoveryCoordinator(...args);
    const authorized = this.operatorCredentialGuard.authorizeFromOperatorGuidance(decision.guidance);
    if (authorized.length) {
      this.stats.operatorCredentialAuthorizations = (this.stats.operatorCredentialAuthorizations ?? 0) + authorized.length;
      this.ui?.log?.(`Operator credential context authorized validation use for: ${authorized.join(', ')}.`);
    }
    return decision;
  }

  async runWorkerPass(worker, ...args) {
    const result = await super.runWorkerPass(worker, ...args);
    const violations = this.operatorCredentialGuard.consumeViolations(worker.name);
    const reconciled = reconcileCredentialIntegrityReport(result.report, violations, `Worker ${worker.name}`);
    if (reconciled.correction) this.ui?.log?.(reconciled.correction);
    return {
      ...result,
      report: reconciled.report,
      credentialIntegrityCorrection: reconciled.correction,
    };
  }

  async reviewPass(reviewer, task, implementationPass, reviewCycle, routing, taskContext) {
    const beforeReview = await this.revisionProvider(this.workspace);
    const manifest = await this.currentTaskChangeManifest(taskContext);
    const startedAt = Date.now();
    const review = await requireReport(
      reviewer.session,
      reviewer.sink,
      [
        taskPrompt(task),
        '',
        `The implementer reports current workspace revision ${beforeReview}.`,
        `Task workflow: ${routing.route}; task risk: ${routing.risk}.`,
        formatValidationEvidence(evidenceFromPass(implementationPass)),
        manifest ? `\n${formatTaskChangeManifest(manifest, 'Deterministic task change manifest for this review')}` : '',
        '',
        reviewCycle > 1
          ? 'Re-check your earlier findings against the remediated current revision. Inspect only enough additional context to detect remaining defects or regressions.'
          : 'Independently review the implementation against every explicit requirement in the benchmark request.',
        'Do not edit files. Call report_review exactly once as soon as you have the verdict.',
      ].filter(Boolean).join('\n'),
      'report_review',
      this.agentTurnTimeoutMs,
    );
    const afterReview = await this.revisionProvider(this.workspace);
    const usage = await this.finishTurn(reviewer, startedAt);
    if (beforeReview !== afterReview) throw new Error('Strong reviewer changed the workspace despite the read-only contract.');
    const violations = this.operatorCredentialGuard.consumeViolations('Strong reviewer');
    const reconciled = reconcileCredentialIntegrityReport(review, violations, 'Strong reviewer');
    if (reconciled.correction) this.ui?.log?.(reconciled.correction);
    this.ui.reviewResult?.(reconciled.report, reviewCycle, { durationMs: Date.now() - startedAt, usage });
    return reconciled.report;
  }

  async recoverBlockedImplementer(worker, task, blockedPass, routing, taskContext, label = 'Implementer') {
    if (blockedPass.report?.verdict !== 'blocked') return blockedPass;
    if (this.recoveryPolicy === RECOVERY_POLICIES.NONE) {
      throw new Error(`${label} is blocked: ${blockedPass.report.summary}`);
    }

    let current = blockedPass;
    for (let attempt = 1; attempt <= this.maxExperimentalRecoveryAttempts; attempt += 1) {
      const decision = await this.consultRecoveryCoordinator(task, `worker-${worker.name}`, {
        changed: current.changed,
        workspaceFingerprint: current.revision,
        summary: current.report?.summary,
        checks: current.report?.checks ?? [],
        evidence: evidenceFromPass(current),
      }, { allowPeer: false });

      if (decision.action !== 'retry') {
        throw new Error(`On-demand recovery did not produce a retry for ${label}: ${decision.rationale}`);
      }
      queueRecoveryInstruction(worker.session, decision.guidance || decision.rationale);
      this.ui.phase?.('Recovery retry', `${label} retries the preserved workspace after strong recovery-coordinator guidance (attempt ${attempt}).`);
      current = await this.runWorkerPass(worker, task, 'REVIEW_AND_FIX', null, null, taskContext);
      this.ui.passResult?.(label, current.report, current.changed, current.revision, current);
      if (current.report.verdict !== 'blocked') return current;
    }
    throw new Error(`${label} remains blocked after ${this.maxExperimentalRecoveryAttempts} on-demand recovery attempt(s): ${current.report?.summary ?? ''}`);
  }

  async recoverBlockedReviewer(reviewer, task, implementationPass, blockedReview, reviewCycle, routing, taskContext) {
    if (blockedReview.verdict !== 'blocked') return blockedReview;
    if (this.recoveryPolicy === RECOVERY_POLICIES.NONE) {
      throw new Error(`Strong reviewer is blocked: ${blockedReview.summary}`);
    }
    const decision = await this.consultRecoveryCoordinator(task, 'strong-reviewer', {
      summary: blockedReview.summary,
      checks: blockedReview.checks ?? [],
      evidence: evidenceFromPass(implementationPass),
      workspaceFingerprint: await this.revisionProvider(this.workspace),
    }, { allowPeer: false });
    if (decision.action !== 'retry') {
      throw new Error(`On-demand reviewer recovery did not produce a retry: ${decision.rationale}`);
    }
    queueRecoveryInstruction(reviewer.session, decision.guidance || decision.rationale);
    this.ui.phase?.('Reviewer recovery retry', 'Strong reviewer retries after on-demand recovery-coordinator guidance.');
    return this.reviewPass(reviewer, task, implementationPass, reviewCycle, routing, taskContext);
  }

  async runSingleAgent(factory, task, routing, taskContext) {
    let worker;
    try {
      worker = await factory.createWorker('1-benchmark-task', 'A', routing.route, routing.risk);
      this.sessions.push(worker.session);
      this.ui.agentConfiguration?.([
        { role: 'Implementer', model: worker.model.name ?? worker.model.id, effort: worker.reasoningEffort },
      ]);
      let pass = await this.runWorkerPass(worker, task, 'IMPLEMENT', null, null, taskContext);
      this.ui.passResult?.('Implementer', pass.report, pass.changed, pass.revision, pass);
      pass = await this.recoverBlockedImplementer(worker, task, pass, routing, taskContext, 'Implementer');
      return { pass, reviews: [] };
    } finally {
      await this.disposeTaskSessions([worker?.session]);
    }
  }

  async runImplementerReviewer(factory, task, routing, taskContext) {
    let worker;
    let reviewer;
    try {
      worker = await factory.createWorker('1-benchmark-task', 'A', routing.route, routing.risk);
      reviewer = await factory.createReviewer('1-benchmark-task', routing.route, routing.risk);
      this.sessions.push(worker.session, reviewer.session);
      this.ui.agentConfiguration?.([
        { role: 'Implementer', model: worker.model.name ?? worker.model.id, effort: worker.reasoningEffort },
        { role: 'Strong reviewer', model: reviewer.model.name ?? reviewer.model.id, effort: reviewer.reasoningEffort },
      ]);

      let implementationPass = await this.runWorkerPass(worker, task, 'IMPLEMENT', null, null, taskContext);
      this.ui.passResult?.('Implementer', implementationPass.report, implementationPass.changed, implementationPass.revision, implementationPass);
      implementationPass = await this.recoverBlockedImplementer(worker, task, implementationPass, routing, taskContext, 'Implementer');

      const reviews = [];
      for (let reviewCycle = 1; reviewCycle <= this.maxReviewerCycles; reviewCycle += 1) {
        let review = await this.reviewPass(reviewer, task, implementationPass, reviewCycle, routing, taskContext);
        review = await this.recoverBlockedReviewer(reviewer, task, implementationPass, review, reviewCycle, routing, taskContext);
        reviews.push(review);
        if (review.verdict === 'clean') return { pass: implementationPass, reviews };
        if (review.verdict === 'blocked') throw new Error(`Strong reviewer remains blocked after recovery: ${review.summary}`);
        if (!review.findings?.length) throw new Error('Strong reviewer returned findings without actionable findings.');
        if (reviewCycle === this.maxReviewerCycles) {
          throw new Error(`Strong review still has findings after ${this.maxReviewerCycles} remediation cycles.`);
        }

        this.ui.phase?.('Remediation', `Strong reviewer returned ${review.findings.length} finding(s); the same implementer remediates without peer convergence.`);
        implementationPass = await this.runWorkerPass(
          worker,
          task,
          'FIX_STRONG_REVIEW_FINDINGS',
          review.findings,
          null,
          taskContext,
        );
        this.ui.passResult?.('Implementer', implementationPass.report, implementationPass.changed, implementationPass.revision, implementationPass);
        implementationPass = await this.recoverBlockedImplementer(
          worker,
          task,
          implementationPass,
          routing,
          taskContext,
          'Implementer during reviewer remediation',
        );
      }
      throw new Error('Strong reviewer loop ended without a clean verdict.');
    } finally {
      await this.disposeTaskSessions([worker?.session, reviewer?.session]);
    }
  }

  async runPeerCompetition(factory, task, routing, taskContext, withReviewer) {
    let workerA;
    let workerB;
    let reviewer;
    try {
      workerA = await factory.createWorker('1-benchmark-task', 'A', routing.route, routing.risk);
      workerB = await factory.createWorker('1-benchmark-task', 'B', routing.route, routing.risk);
      if (withReviewer) reviewer = await factory.createReviewer('1-benchmark-task', routing.route, routing.risk);
      this.sessions.push(workerA.session, workerB.session, ...(reviewer ? [reviewer.session] : []));
      this.ui.agentConfiguration?.([
        { role: 'Peer A', model: workerA.model.name ?? workerA.model.id, effort: workerA.reasoningEffort },
        { role: 'Peer B', model: workerB.model.name ?? workerB.model.id, effort: workerB.reasoningEffort },
        ...(reviewer ? [{ role: 'Strong reviewer', model: reviewer.model.name ?? reviewer.model.id, effort: reviewer.reasoningEffort }] : []),
      ]);

      const initial = await this.runWorkerPass(workerA, task, 'IMPLEMENT', null, null, taskContext);
      this.ui.passResult?.('A', initial.report, initial.changed, initial.revision, initial);
      if (initial.report.verdict === 'blocked') throw new Error(`Worker A is blocked: ${initial.report.summary}`);

      const convergence = await this.convergeWorkers(task, workerA, workerB, workerB, initial, taskContext);
      if (reviewer) {
        await this.runStrongReview(task, workerA, workerB, reviewer, convergence.evidence, routing, taskContext);
      }
      return { initial, convergence, reviewed: Boolean(reviewer) };
    } finally {
      await this.disposeTaskSessions([workerA?.session, workerB?.session, reviewer?.session]);
    }
  }

  async run(userRequest) {
    await this.validateWorkspace();
    this.checkCancelled();
    if (this.architecture === ARCHITECTURES.CONVERGENT_V02) {
      throw new Error('convergent-v02 must use the released RecoveryConvergentEngine, not ExperimentalTopologyEngine.');
    }

    const task = benchmarkTask(userRequest, { route: this.experimentalRoute, risk: this.experimentalRisk });
    const routing = { route: this.experimentalRoute, risk: this.experimentalRisk, routingReason: task.routingReason };
    const policy = routePolicy(routing.route, routing.risk);
    const plan = {
      summary: `Experimental benchmark architecture: ${this.architecture}; recovery=${this.recoveryPolicy}`,
      tasks: [task],
    };
    const factory = this.createFactory();
    const taskContext = await this.createTaskContext(factory);

    this.activeTaskChangeContext = taskContext;
    this.stats.tasks = 1;
    this.stats.full = 1;
    this.stats.architecture = this.architecture;
    this.stats.recoveryPolicy = this.recoveryPolicy;
    this.ui.phase?.('Experimental benchmark', `Running ${this.architecture} with recovery=${this.recoveryPolicy} on one fixed benchmark task.`);
    this.ui.plan?.(plan, [routing]);
    this.ui.taskStarted?.(task, 1, 1, routing, policy);

    try {
      let topologyResult;
      if (this.architecture === ARCHITECTURES.SINGLE_AGENT) {
        topologyResult = await this.runSingleAgent(factory, task, routing, taskContext);
      } else if (this.architecture === ARCHITECTURES.IMPLEMENTER_REVIEWER) {
        topologyResult = await this.runImplementerReviewer(factory, task, routing, taskContext);
      } else if (this.architecture === ARCHITECTURES.PEER_COMPETITION) {
        topologyResult = await this.runPeerCompetition(factory, task, routing, taskContext, false);
      } else if (this.architecture === ARCHITECTURES.PEER_COMPETITION_REVIEWER) {
        topologyResult = await this.runPeerCompetition(factory, task, routing, taskContext, true);
      } else {
        throw new Error(`Experimental architecture ${this.architecture} is not implemented.`);
      }

      const finalUsage = this.getUsageSummary();
      this.ui.taskCompleted?.(task, this.architecture);
      this.ui.phase?.('Complete', `Experimental architecture ${this.architecture} completed.`);
      this.ui.runSummary?.(finalUsage, this.stats);
      return {
        plan,
        architecture: this.architecture,
        recoveryPolicy: this.recoveryPolicy,
        topologyResult,
        usage: finalUsage,
        stats: { ...this.stats },
      };
    } finally {
      this.activeTaskChangeContext = null;
    }
  }
}

module.exports = {
  ARCHITECTURES,
  RECOVERY_POLICIES,
  VALID_ARCHITECTURES,
  VALID_RECOVERY_POLICIES,
  normalizeArchitecture,
  normalizeRecoveryPolicy,
  architectureMetadata,
  benchmarkTask,
  ExperimentalTopologyEngine,
};
