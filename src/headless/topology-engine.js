'use strict';

const { RecoveryConvergentEngine } = require('../orchestrator/recovery-engine');
const {
  requireReport,
  taskPrompt,
  formatValidationEvidence,
} = require('../orchestrator/engine');
const { formatTaskChangeManifest } = require('../orchestrator/task-change-manifest');
const { routePolicy, chooseReasoningEffort } = require('../orchestrator/routing');
const { reviewerFlowInstructions } = require('../orchestrator/flow');
const { workspaceScopePrompt } = require('../orchestrator/workspace-scope');
const { createPassTool, createReviewTool } = require('../copilot/tools');
const {
  SessionFactory,
  attachEventLogging,
  readonlyHook,
  workerHook,
  safeSessionPart,
  withReasoning,
  REVIEWER_TOOLS,
  WORKER_TOOLS,
} = require('../copilot/session-factory');
const { topologyConfig, normalizeTopology } = require('./topology');

const DEFAULT_MAX_PEER_CRITIC_CYCLES = 2;

const PEER_CRITIC_PROMPT = `
You are Convergent's bounded independent peer critic for an architecture benchmark.

You are READ-ONLY. Do not edit files. Your purpose is narrower than the final strong reviewer:
- inspect the implementer's actual task diff and the minimum surrounding code needed to understand it;
- look adversarially for concrete correctness, security, compatibility, edge-case, or acceptance-criteria defects the implementer missed;
- do not reimplement the task, do not perform broad repository discovery, and do not repeat validation without a concrete question;
- prefer one precise actionable finding over speculative commentary;
- report CLEAN when you found no actionable defect.

Call report_review exactly once with CLEAN, FINDINGS, or BLOCKED. Never modify the workspace.
`.trim();

const COMPACT_WORKER_A_PROMPT = `
You are Worker A for one standard implementation task.

Implement the smallest complete change that satisfies the task and acceptance criteria while following existing repository patterns.
- Inspect only what is needed. Reuse supplied evidence; do not reread unchanged files or rerun successful checks without a concrete reason.
- Keep scope strict. Do not add unrelated cleanup, features, dependencies, compatibility layers, or documentation.
- Protect pre-existing dirty/staged/untracked user state. Never delete or revert a path merely to make the worktree clean.
- Use file-edit tools for content changes, not shell redirection. Use run_command for tests/builds whose completion matters, and keep validation non-polluting.
- A Convergent workspace fingerprint is an opaque state hash, not a Git object; never resolve it with Git commands.
- Use Explore only when relevant locations are genuinely unknown; continue from its compact findings without repeating discovery.
- If a material fact or user decision is required, report BLOCKED rather than guessing.

Call report_pass exactly once when finished. findings contains only unresolved actionable issues. CLEAN means no edits and no unresolved issue; CHANGED means substantive task edits are complete and approved; BLOCKED means correctness cannot safely be established. Keep summary/checks concise and evidence-based.
`.trim();

const COMPACT_REVIEWER_PROMPT = `
You are the read-only strong quality gate for one standard implementation task.

Review the exact task changes against the task and acceptance criteria. Inspect the changed files plus only directly affected contracts/tests needed to judge correctness.
- Find concrete correctness, regression, error-handling, compatibility, security, concurrency, scope, or test gaps that matter to this task; do not broaden into a repository audit.
- Collect independently discoverable actionable findings in one bounded sweep instead of stopping at the first issue.
- Treat worker validation on the exact current state as useful evidence. Rerun validation only when a concrete concern requires it, and keep validation non-polluting.
- Protect pre-existing user workspace state; unrelated dirty/untracked paths are not findings without evidence this task changed them.
- A Convergent workspace fingerprint is an opaque state hash, not a Git object.
- Use Explore only when a directly relevant location is genuinely unknown.

Call report_review exactly once. CLEAN requires findings=[]; FINDINGS contains only unresolved actionable findings; BLOCKED is only for a substantive inability to establish correctness. Be terse and make the structured report authoritative.
`.trim();

const LEAN_WORKER_A_PROMPT = `
You are Worker A for one standard implementation task.

Implement the smallest complete change that satisfies the task and acceptance criteria while following existing repository patterns.
- Use batch_view as the primary repository inspection tool; inspect only what is needed and do not perform a second search wave for reassurance.
- Keep scope strict and protect pre-existing dirty/staged/untracked user state. Never clean, revert, or overwrite unrelated user changes.
- Use built-in file edit/create/patch tools for content changes and run_command only for decisive validation. Keep validation non-polluting.
- A Convergent workspace fingerprint is an opaque state hash, not a Git object.
- If a material fact or user decision is required, report BLOCKED rather than guessing.

Call report_pass exactly once when finished. findings contains only unresolved actionable issues. CLEAN means no edits and no unresolved issue; CHANGED means substantive task edits are complete and approved; BLOCKED means correctness cannot safely be established. Keep summary/checks concise and evidence-based.
`.trim();

const LEAN_REVIEWER_PROMPT = `
You are the read-only strong quality gate for one standard implementation task.

Review the exact task changes against the task and acceptance criteria in one bounded sweep.
- The review turn includes a deterministic task-change manifest and bounded current diff. Treat that packet as primary evidence. Do not reopen changed files merely to reread code already present in the packet; use view/batch_view only for a concrete surrounding contract or test question not answered there.
- Find concrete correctness, regression, error-handling, compatibility, security, concurrency, scope, or test gaps that matter to this task; do not broaden into a repository audit.
- Treat worker validation on the exact current state as useful evidence. Do not rerun tests or git-diff checks for reassurance; run a command only when a concrete concern requires independent evidence.
- Protect pre-existing user workspace state; unrelated dirty/untracked paths are not findings without evidence this task changed them.
- A Convergent workspace fingerprint is an opaque state hash, not a Git object.

Call report_review exactly once. CLEAN requires findings=[]; FINDINGS contains only unresolved actionable findings; BLOCKED is only for a substantive inability to establish correctness. Be terse and make the structured report authoritative.
`.trim();

const LEAN_WORKER_TOOLS = Object.freeze([
  'builtin:view',
  'custom:batch_view',
  'custom:run_command',
  'builtin:apply_patch',
  'builtin:edit',
  'builtin:create',
  'custom:report_pass',
]);

const LEAN_REVIEWER_TOOLS = Object.freeze([
  'builtin:view',
  'custom:batch_view',
  'custom:run_command',
  'custom:report_review',
]);

class BenchmarkSessionFactory extends SessionFactory {
  async createPeerCritic(taskId, route = 'standard', risk = 'medium') {
    const safeTaskId = safeSessionPart(taskId);
    const sink = { value: null };
    const tool = createReviewTool(this.sdk.defineTool, sink);
    const batchView = this.batchViewTool();
    const name = 'Peer critic';
    let guard = null;
    const runCommand = this.runCommandTool(name, () => guard);
    const model = this.workerModel(taskId, 'B', route, risk);
    const effort = chooseReasoningEffort(model, 'low', this.reasoningMode);
    const baselinePrompt = await this.taskBaselinePrompt(taskId);
    const systemPrompt = [
      PEER_CRITIC_PROMPT,
      reviewerFlowInstructions(this.flowMode),
      workspaceScopePrompt(this.workspace, this.workspaceFolders),
      baselinePrompt,
    ].filter(Boolean).join('\n\n');

    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-peer-critic`,
      clientName: 'convergent-headless-topology',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [batchView, runCommand, tool],
      availableTools: REVIEWER_TOOLS,
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: {
        onPreToolUse: (input) => this.preToolUse(readonlyHook, name, input),
      },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));

    guard = this.guard(session, name);
    const usageKey = `${safeTaskId}:peer-critic`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey, {
      sink,
      toolName: 'report_review',
    });
    this.ui.agentTools?.(name, REVIEWER_TOOLS);
    this.sessionCreated(name, session, model, effort, systemPrompt, REVIEWER_TOOLS, {
      role: 'peer-critic',
      taskId: safeTaskId,
      benchmarkOnly: true,
    });

    return {
      session,
      guard,
      sink,
      name,
      usageName: usageKey,
      model,
      reasoningEffort: effort,
    };
  }
}

class CompactStandardSessionFactory extends BenchmarkSessionFactory {
  async createWorker(taskId, worker, route = 'standard', risk = 'medium', sessionAttempt = '') {
    if (worker !== 'A') return super.createWorker(taskId, worker, route, risk, sessionAttempt);
    const safeTaskId = safeSessionPart(taskId);
    const attemptSuffix = sessionAttempt ? `-${safeSessionPart(sessionAttempt)}` : '';
    const sink = { value: null };
    const tool = createPassTool(this.sdk.defineTool, sink);
    const batchView = this.batchViewTool();
    const name = 'Worker A';
    let guard = null;
    const runCommand = this.runCommandTool(name, () => guard);
    const workspaceEdit = this.workspaceEditTool(name);
    const model = this.workerModel(taskId, 'A', route, risk);
    const effort = chooseReasoningEffort(model, routePolicy(route, risk).efforts.workerA, this.reasoningMode);
    const baselinePrompt = await this.taskBaselinePrompt(taskId);
    const systemPrompt = [
      COMPACT_WORKER_A_PROMPT,
      workspaceScopePrompt(this.workspace, this.workspaceFolders),
      baselinePrompt,
    ].filter(Boolean).join('\n\n');
    const exploreAgent = this.exploreAgent();

    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-worker-a${attemptSuffix}`,
      clientName: 'convergent-headless-topology',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [batchView, runCommand, workspaceEdit, tool],
      availableTools: WORKER_TOOLS,
      customAgents: [exploreAgent],
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: { onPreToolUse: (input) => this.preToolUse(workerHook, name, input) },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));

    guard = this.guard(session, name);
    const usageKey = `${safeTaskId}:worker-a${attemptSuffix}`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey, { sink, toolName: 'report_pass' });
    this.ui.agentTools?.(name, WORKER_TOOLS);
    this.sessionCreated(name, session, model, effort, systemPrompt, WORKER_TOOLS, {
      role: 'workerA',
      taskId: safeTaskId,
      route,
      risk,
      sessionAttempt: sessionAttempt || null,
      exploreAgent,
      benchmarkPromptProfile: 'compact-standard',
    });
    return { session, guard, sink, name: 'A', usageName: usageKey, model, reasoningEffort: effort };
  }

  async createReviewer(taskId, route = 'standard', risk = 'medium', sessionAttempt = '') {
    const safeTaskId = safeSessionPart(taskId);
    const attemptSuffix = sessionAttempt ? `-${safeSessionPart(sessionAttempt)}` : '';
    const sink = { value: null };
    const tool = createReviewTool(this.sdk.defineTool, sink);
    const batchView = this.batchViewTool();
    const name = 'Strong reviewer';
    let guard = null;
    const runCommand = this.runCommandTool(name, () => guard);
    const model = this.models.reviewer;
    const effort = chooseReasoningEffort(model, routePolicy(route, risk).efforts.reviewer, this.reasoningMode);
    const baselinePrompt = await this.taskBaselinePrompt(taskId);
    const systemPrompt = [
      COMPACT_REVIEWER_PROMPT,
      workspaceScopePrompt(this.workspace, this.workspaceFolders),
      baselinePrompt,
    ].filter(Boolean).join('\n\n');
    const exploreAgent = this.exploreAgent();

    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-reviewer${attemptSuffix}`,
      clientName: 'convergent-headless-topology',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [batchView, runCommand, tool],
      availableTools: REVIEWER_TOOLS,
      customAgents: [exploreAgent],
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: { onPreToolUse: (input) => this.preToolUse(readonlyHook, name, input) },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));

    guard = this.guard(session, name);
    const usageKey = `${safeTaskId}:reviewer${attemptSuffix}`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey, { sink, toolName: 'report_review' });
    this.ui.agentTools?.(name, REVIEWER_TOOLS);
    this.sessionCreated(name, session, model, effort, systemPrompt, REVIEWER_TOOLS, {
      role: 'reviewer',
      taskId: safeTaskId,
      route,
      risk,
      sessionAttempt: sessionAttempt || null,
      exploreAgent,
      benchmarkPromptProfile: 'compact-standard',
    });
    return { session, guard, sink, name, usageName: usageKey, model, reasoningEffort: effort };
  }
}

class LeanStandardSessionFactory extends CompactStandardSessionFactory {
  async createWorker(taskId, worker, route = 'standard', risk = 'medium', sessionAttempt = '') {
    if (worker !== 'A') return super.createWorker(taskId, worker, route, risk, sessionAttempt);
    const safeTaskId = safeSessionPart(taskId);
    const attemptSuffix = sessionAttempt ? `-${safeSessionPart(sessionAttempt)}` : '';
    const sink = { value: null };
    const tool = createPassTool(this.sdk.defineTool, sink);
    const batchView = this.batchViewTool();
    const name = 'Worker A';
    let guard = null;
    const runCommand = this.runCommandTool(name, () => guard);
    const model = this.workerModel(taskId, 'A', route, risk);
    const effort = chooseReasoningEffort(model, routePolicy(route, risk).efforts.workerA, this.reasoningMode);
    const baselinePrompt = await this.taskBaselinePrompt(taskId);
    const systemPrompt = [
      LEAN_WORKER_A_PROMPT,
      workspaceScopePrompt(this.workspace, this.workspaceFolders),
      baselinePrompt,
    ].filter(Boolean).join('\n\n');

    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-worker-a${attemptSuffix}`,
      clientName: 'convergent-headless-topology',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [batchView, runCommand, tool],
      availableTools: [...LEAN_WORKER_TOOLS],
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: { onPreToolUse: (input) => this.preToolUse(workerHook, name, input) },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));

    guard = this.guard(session, name);
    const usageKey = `${safeTaskId}:worker-a${attemptSuffix}`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey, { sink, toolName: 'report_pass' });
    this.ui.agentTools?.(name, LEAN_WORKER_TOOLS);
    this.sessionCreated(name, session, model, effort, systemPrompt, LEAN_WORKER_TOOLS, {
      role: 'workerA',
      taskId: safeTaskId,
      route,
      risk,
      sessionAttempt: sessionAttempt || null,
      benchmarkPromptProfile: 'lean-standard',
      benchmarkToolProfile: 'lean-standard',
    });
    return { session, guard, sink, name: 'A', usageName: usageKey, model, reasoningEffort: effort };
  }

  async createReviewer(taskId, route = 'standard', risk = 'medium', sessionAttempt = '') {
    const safeTaskId = safeSessionPart(taskId);
    const attemptSuffix = sessionAttempt ? `-${safeSessionPart(sessionAttempt)}` : '';
    const sink = { value: null };
    const tool = createReviewTool(this.sdk.defineTool, sink);
    const batchView = this.batchViewTool();
    const name = 'Strong reviewer';
    let guard = null;
    const runCommand = this.runCommandTool(name, () => guard);
    const model = this.models.reviewer;
    const effort = chooseReasoningEffort(model, routePolicy(route, risk).efforts.reviewer, this.reasoningMode);
    const baselinePrompt = await this.taskBaselinePrompt(taskId);
    const systemPrompt = [
      LEAN_REVIEWER_PROMPT,
      workspaceScopePrompt(this.workspace, this.workspaceFolders),
      baselinePrompt,
    ].filter(Boolean).join('\n\n');

    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-reviewer${attemptSuffix}`,
      clientName: 'convergent-headless-topology',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [batchView, runCommand, tool],
      availableTools: [...LEAN_REVIEWER_TOOLS],
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: { onPreToolUse: (input) => this.preToolUse(readonlyHook, name, input) },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));

    guard = this.guard(session, name);
    const usageKey = `${safeTaskId}:reviewer${attemptSuffix}`;
    attachEventLogging(session, name, this.ui, this.usage, model, usageKey, { sink, toolName: 'report_review' });
    this.ui.agentTools?.(name, LEAN_REVIEWER_TOOLS);
    this.sessionCreated(name, session, model, effort, systemPrompt, LEAN_REVIEWER_TOOLS, {
      role: 'reviewer',
      taskId: safeTaskId,
      route,
      risk,
      sessionAttempt: sessionAttempt || null,
      benchmarkPromptProfile: 'lean-standard',
      benchmarkToolProfile: 'lean-standard',
    });
    return { session, guard, sink, name, usageName: usageKey, model, reasoningEffort: effort };
  }
}

class BenchmarkTopologyEngine extends RecoveryConvergentEngine {
  constructor(options = {}) {
    super(options);
    this.topology = normalizeTopology(options.topology);
    this.topologyConfig = topologyConfig(this.topology);
    this.maxPeerCriticCycles = Math.max(
      1,
      Number(options.maxPeerCriticCycles) || DEFAULT_MAX_PEER_CRITIC_CYCLES,
    );
  }

  sessionFactory() {
    let Factory = BenchmarkSessionFactory;
    if (this.topologyConfig.promptProfile === 'compact-standard') Factory = CompactStandardSessionFactory;
    if (this.topologyConfig.promptProfile === 'lean-standard') Factory = LeanStandardSessionFactory;
    return new Factory({
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
    });
  }

  benchmarkRouting(routing, peerConvergence) {
    return {
      ...routing,
      peerConvergence,
      benchmarkTopology: this.topology,
    };
  }

  async runTask(factory, task, taskSessionKey, routing, taskResumeState = null) {
    const effectiveRouting = routing?.route === 'trivial' && this.topologyConfig.peerMode !== 'converge'
      ? this.benchmarkRouting({ ...routing, route: 'standard' }, false)
      : routing;
    return super.runTask(factory, task, taskSessionKey, effectiveRouting, taskResumeState);
  }

  async runTrivialTask(factory, task, taskSessionKey, routing) {
    if (this.topologyConfig.peerMode === 'converge') {
      return super.runTrivialTask(factory, task, taskSessionKey, routing);
    }
    const promoted = this.benchmarkRouting({
      ...routing,
      route: 'standard',
      risk: routing?.risk ?? 'low',
    }, false);
    return this.runFullTask(factory, task, taskSessionKey, promoted);
  }

  async runFullTask(factory, task, taskSessionKey, routing, taskResumeState = null) {
    if (this.topologyConfig.peerMode === 'converge') {
      return super.runFullTask(
        factory,
        task,
        taskSessionKey,
        this.benchmarkRouting(routing, true),
        taskResumeState,
      );
    }

    if (this.topologyConfig.peerMode === 'critic') {
      if (taskResumeState) {
        throw new Error('Read-only peer-critic benchmark topology does not support /resume; start the benchmark from a fresh fixture checkout.');
      }
      return this.runPeerCriticTask(
        factory,
        task,
        taskSessionKey,
        this.benchmarkRouting(routing, false),
      );
    }

    return super.runFullTask(
      factory,
      task,
      taskSessionKey,
      this.benchmarkRouting(routing, false),
      taskResumeState,
    );
  }

  async runPeerCriticPass(peerCritic, task, evidence, cycle) {
    const before = await this.revisionProvider(this.workspace, this.workspaceFolders);
    const manifest = await this.currentTaskChangeManifest(this.activeTaskChangeContext);
    const startedAt = Date.now();
    const review = await requireReport(
      peerCritic.session,
      peerCritic.sink,
      [
        taskPrompt(task),
        '',
        `PEER CRITIC CYCLE: ${cycle}/${this.maxPeerCriticCycles}`,
        `Current workspace revision fingerprint: ${before}.`,
        formatValidationEvidence(evidence),
        manifest
          ? `\n${formatTaskChangeManifest(manifest, 'Deterministic task change manifest for peer criticism')}`
          : '',
        '',
        'Inspect the exact current task changes first. Look only for concrete defects the implementer may have missed. Do not edit files. Do not broaden scope. Call report_review exactly once.',
      ].filter(Boolean).join('\n'),
      'report_review',
      this.agentTurnTimeoutMs,
    );
    const after = await this.revisionProvider(this.workspace, this.workspaceFolders);
    const usage = await this.finishTurn(peerCritic, startedAt);
    if (before !== after) {
      throw new Error('Peer critic changed the workspace despite the read-only benchmark contract.');
    }
    this.ui?.audit?.({
      type: 'benchmark_peer_critic_result',
      topology: this.topology,
      taskId: task.id,
      cycle,
      verdict: review.verdict,
      summary: review.summary,
      findings: review.findings ?? [],
      usage,
    });
    this.ui?.phase?.(
      'Peer critic',
      review.verdict === 'clean'
        ? `Read-only peer critic found no actionable defect in cycle ${cycle}.`
        : `Read-only peer critic returned ${review.findings?.length ?? 0} finding(s) in cycle ${cycle}.`,
    );
    return review;
  }

  async runPeerCriticTask(factory, task, taskSessionKey, routing) {
    let workerA;
    let peerCritic;
    let reviewer;
    try {
      workerA = await factory.createWorker(taskSessionKey, 'A', routing.route, routing.risk);
      peerCritic = await factory.createPeerCritic(taskSessionKey, routing.route, routing.risk);
      reviewer = await factory.createReviewer(taskSessionKey, routing.route, routing.risk);
      this.sessions.push(workerA.session, peerCritic.session, reviewer.session);
      this.ui.agentConfiguration([
        { role: 'A', model: workerA.model.name ?? workerA.model.id, effort: workerA.reasoningEffort },
        { role: 'Peer critic', model: peerCritic.model.name ?? peerCritic.model.id, effort: peerCritic.reasoningEffort },
        { role: 'Strong reviewer', model: reviewer.model.name ?? reviewer.model.id, effort: reviewer.reasoningEffort },
      ]);

      const initial = await this.runWorkerPass(workerA, task, 'IMPLEMENT', null, null);
      this.ui.passResult('A', initial.report, initial.changed, initial.revision, initial);
      let resolved = await this.resolveSingleWorkerPass(task, workerA, initial, routing, {
        nextReviewCycle: 1,
      });
      let evidence = resolved.evidence;

      for (let cycle = 1; cycle <= this.maxPeerCriticCycles; cycle += 1) {
        const peerReview = await this.runPeerCriticPass(peerCritic, task, evidence, cycle);
        if (peerReview.verdict === 'clean') break;
        if (peerReview.verdict === 'blocked') {
          throw new Error(`Read-only peer critic is blocked: ${peerReview.summary}`);
        }
        if (!peerReview.findings?.length) {
          throw new Error('Peer critic returned FINDINGS without actionable findings.');
        }
        if (cycle === this.maxPeerCriticCycles) {
          throw new Error(`Peer critic still has findings after ${this.maxPeerCriticCycles} bounded cycle(s).`);
        }

        this.ui?.phase?.(
          'Peer remediation',
          `Worker A is addressing ${peerReview.findings.length} read-only peer finding(s); the peer critic will then delta-check the result.`,
        );
        const remediation = await this.runWorkerPass(
          workerA,
          task,
          'FIX_PEER_CRITIC_FINDINGS',
          peerReview.findings,
          null,
        );
        this.ui.passResult('A', remediation.report, remediation.changed, remediation.revision, remediation);
        resolved = await this.resolveSingleWorkerPass(task, workerA, remediation, routing, {
          nextReviewCycle: 1,
        });
        evidence = resolved.evidence;
      }

      await this.saveTaskCheckpoint({
        stage: 'strong_review_pending',
        nextReviewCycle: 1,
        evidence,
        routing,
      });
      await this.checkAiCreditBudget(`before strong review for ${task.id}`);
      await this.runStrongReview(task, workerA, null, reviewer, evidence, routing, {
        startReviewCycle: 1,
      });
      return { route: routing.route, escalated: false };
    } finally {
      await this.disposeTaskSessions([
        workerA?.session,
        peerCritic?.session,
        reviewer?.session,
      ]);
    }
  }
}

module.exports = {
  PEER_CRITIC_PROMPT,
  COMPACT_WORKER_A_PROMPT,
  COMPACT_REVIEWER_PROMPT,
  LEAN_WORKER_A_PROMPT,
  LEAN_REVIEWER_PROMPT,
  LEAN_WORKER_TOOLS,
  LEAN_REVIEWER_TOOLS,
  DEFAULT_MAX_PEER_CRITIC_CYCLES,
  BenchmarkSessionFactory,
  CompactStandardSessionFactory,
  LeanStandardSessionFactory,
  BenchmarkTopologyEngine,
};
