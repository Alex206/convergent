'use strict';

const { assertGitRepository } = require('../orchestrator/revision');
const { routePolicy } = require('../orchestrator/routing');
const {
  ConvergentEngine,
  requireReport,
  taskPrompt,
  evidenceFromPass,
  formatValidationEvidence,
} = require('../orchestrator/engine');
const { formatTaskChangeManifest } = require('../orchestrator/task-change-manifest');
const { SessionFactory } = require('../copilot/session-factory');

const ARCHITECTURES = Object.freeze({
  SINGLE_AGENT: 'single-agent',
  IMPLEMENTER_REVIEWER: 'implementer-reviewer',
  CONVERGENT_V02: 'convergent-v02',
});

const VALID_ARCHITECTURES = new Set(Object.values(ARCHITECTURES));

function normalizeArchitecture(value) {
  const normalized = String(value ?? ARCHITECTURES.CONVERGENT_V02).trim().toLowerCase();
  const aliases = {
    current: ARCHITECTURES.CONVERGENT_V02,
    convergent: ARCHITECTURES.CONVERGENT_V02,
    '0.2': ARCHITECTURES.CONVERGENT_V02,
    single: ARCHITECTURES.SINGLE_AGENT,
    reviewer: ARCHITECTURES.IMPLEMENTER_REVIEWER,
    'implementer+reviewer': ARCHITECTURES.IMPLEMENTER_REVIEWER,
  };
  const resolved = aliases[normalized] ?? normalized;
  if (!VALID_ARCHITECTURES.has(resolved)) {
    throw new Error(`Unsupported benchmark architecture: ${value}. Expected one of: ${[...VALID_ARCHITECTURES].join(', ')}`);
  }
  return resolved;
}

function architectureMetadata(architecture, options = {}) {
  const id = normalizeArchitecture(architecture);
  if (id === ARCHITECTURES.SINGLE_AGENT) {
    return {
      id,
      topology: 'implementer',
      activeRoles: ['implementer'],
      selectors: { implementer: options.workerA ?? 'adaptive' },
      independentReviewer: false,
      peerConvergence: false,
      coordinator: false,
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

class ExperimentalTopologyEngine extends ConvergentEngine {
  constructor(options = {}) {
    super(options);
    this.architecture = normalizeArchitecture(options.architecture);
    this.experimentalRoute = options.experimentalRoute ?? 'standard';
    this.experimentalRisk = options.experimentalRisk ?? 'medium';
  }

  async validateWorkspace() {
    await assertGitRepository(this.workspace);
  }

  createFactory() {
    return new SessionFactory({
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
    });
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
    this.ui.reviewResult?.(review, reviewCycle, { durationMs: Date.now() - startedAt, usage });
    return review;
  }

  async runSingleAgent(factory, task, routing, taskContext) {
    let worker;
    try {
      worker = await factory.createWorker('1-benchmark-task', 'A', routing.route, routing.risk);
      this.sessions.push(worker.session);
      this.ui.agentConfiguration?.([
        { role: 'Implementer', model: worker.model.name ?? worker.model.id, effort: worker.reasoningEffort },
      ]);
      const pass = await this.runWorkerPass(worker, task, 'IMPLEMENT', null, null, taskContext);
      this.ui.passResult?.('Implementer', pass.report, pass.changed, pass.revision, pass);
      if (pass.report.verdict === 'blocked') throw new Error(`Implementer is blocked: ${pass.report.summary}`);
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
      if (implementationPass.report.verdict === 'blocked') throw new Error(`Implementer is blocked: ${implementationPass.report.summary}`);

      const reviews = [];
      for (let reviewCycle = 1; reviewCycle <= this.maxReviewerCycles; reviewCycle += 1) {
        const review = await this.reviewPass(reviewer, task, implementationPass, reviewCycle, routing, taskContext);
        reviews.push(review);
        if (review.verdict === 'clean') return { pass: implementationPass, reviews };
        if (review.verdict === 'blocked') throw new Error(`Strong reviewer is blocked: ${review.summary}`);
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
        if (implementationPass.report.verdict === 'blocked') {
          throw new Error(`Implementer is blocked during reviewer remediation: ${implementationPass.report.summary}`);
        }
      }
      throw new Error('Strong reviewer loop ended without a clean verdict.');
    } finally {
      await this.disposeTaskSessions([worker?.session, reviewer?.session]);
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
      summary: `Experimental benchmark architecture: ${this.architecture}`,
      tasks: [task],
    };
    const factory = this.createFactory();
    const taskContext = await this.createTaskContext(factory);

    this.stats.tasks = 1;
    this.stats.full = 1;
    this.stats.architecture = this.architecture;
    this.ui.phase?.('Experimental benchmark', `Running ${this.architecture} on one fixed benchmark task.`);
    this.ui.plan?.(plan, [routing]);
    this.ui.taskStarted?.(task, 1, 1, routing, policy);

    const topologyResult = this.architecture === ARCHITECTURES.SINGLE_AGENT
      ? await this.runSingleAgent(factory, task, routing, taskContext)
      : await this.runImplementerReviewer(factory, task, routing, taskContext);

    const finalUsage = this.getUsageSummary();
    this.ui.taskCompleted?.(task, this.architecture);
    this.ui.phase?.('Complete', `Experimental architecture ${this.architecture} completed.`);
    this.ui.runSummary?.(finalUsage, this.stats);
    return {
      plan,
      architecture: this.architecture,
      topologyResult,
      usage: finalUsage,
      stats: { ...this.stats },
    };
  }
}

module.exports = {
  ARCHITECTURES,
  VALID_ARCHITECTURES,
  normalizeArchitecture,
  architectureMetadata,
  benchmarkTask,
  ExperimentalTopologyEngine,
};
