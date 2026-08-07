'use strict';

const { ConvergentEngine, requireReport } = require('./engine');
const { assertGitRepository } = require('./revision');
const { normalizeTaskRoute, routePolicy } = require('./routing');
const { SessionFactory } = require('../copilot/session-factory');
const { RESUME_STATE_VERSION, defaultStats } = require('./resume');

class ResumableConvergentEngine extends ConvergentEngine {
  constructor(options) {
    super(options);
    this.onCheckpoint = typeof options.onCheckpoint === 'function' ? options.onCheckpoint : async () => {};
  }

  async saveCheckpoint({ request, plan, status, nextTaskIndex, currentTaskIndex = null, stage }) {
    let revision;
    try {
      revision = await this.revisionProvider(this.workspace);
    } catch {
      revision = undefined;
    }
    const state = {
      version: RESUME_STATE_VERSION,
      workspace: this.workspace,
      request,
      plan,
      status,
      nextTaskIndex,
      currentTaskIndex,
      stage,
      revision,
      stats: { ...this.stats },
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.onCheckpoint(state);
    } catch (error) {
      this.ui?.log?.(`Could not persist resume checkpoint: ${error.message ?? String(error)}`);
    }
    return state;
  }

  async run(userRequest, resumeState = null) {
    await assertGitRepository(this.workspace);
    this.checkCancelled();

    const factory = new SessionFactory({
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

    let coordinator = null;
    let plan;
    let startTaskIndex = 0;
    let planningUsage = null;

    if (resumeState) {
      plan = resumeState.plan;
      startTaskIndex = resumeState.startTaskIndex;
      this.stats = { ...defaultStats(plan.tasks.length), ...resumeState.stats, tasks: plan.tasks.length };
      const task = plan.tasks[startTaskIndex];
      const detail = resumeState.currentTaskIndex === null
        ? `Continuing with task ${startTaskIndex + 1}/${plan.tasks.length}: ${task.title}.`
        : `Restarting interrupted task ${startTaskIndex + 1}/${plan.tasks.length} from the current workspace state: ${task.title}. Completed tasks will not be rerun.`;
      this.ui.phase('Resuming', detail);
    } else {
      this.ui.phase('Planning', 'Coordinator is inspecting the repository, classifying risk, and choosing the proportionate workflow.');
      coordinator = await factory.createCoordinator();
      this.sessions.push(coordinator.session);
      this.ui.agentConfiguration([
        { role: 'Coordinator', model: coordinator.model.name ?? coordinator.model.id, effort: coordinator.reasoningEffort },
      ]);

      const beforePlan = await this.revisionProvider(this.workspace);
      const planStartedAt = Date.now();
      plan = await requireReport(
        coordinator.session,
        coordinator.sink,
        `User request:\n\n${userRequest}\n\nInspect only what is needed, clarify material ambiguity, classify every task, and submit the smallest proportionate plan with report_plan. For read_only tasks, perform the inspection now and include the answer in task.result.`,
        'report_plan',
        this.agentTurnTimeoutMs,
      );
      const afterPlan = await this.revisionProvider(this.workspace);
      planningUsage = await this.finishTurn(coordinator, planStartedAt);
      if (beforePlan !== afterPlan) throw new Error('Coordinator changed the workspace despite the read-only contract.');
      this.stats = defaultStats(plan.tasks.length);
    }

    const routings = plan.tasks.map((task) => normalizeTaskRoute(task, this.routingMode));
    for (let index = 0; index < plan.tasks.length; index += 1) {
      if (routings[index].route === 'read_only' && !plan.tasks[index].result) {
        throw new Error(`Coordinator classified task ${plan.tasks[index].id} as read_only but did not provide task.result.`);
      }
    }

    this.ui.plan(plan, routings);
    if (planningUsage) this.ui.usageProgress(planningUsage);
    await this.saveCheckpoint({
      request: userRequest,
      plan,
      status: 'ready',
      nextTaskIndex: startTaskIndex,
      currentTaskIndex: resumeState?.currentTaskIndex ?? null,
      stage: resumeState ? 'resume_ready' : 'plan_complete',
    });

    for (let index = startTaskIndex; index < plan.tasks.length; index += 1) {
      this.checkCancelled();
      const task = plan.tasks[index];
      const routing = routings[index];
      const policy = routePolicy(routing.route, routing.risk);

      await this.saveCheckpoint({
        request: userRequest,
        plan,
        status: 'running',
        nextTaskIndex: index,
        currentTaskIndex: index,
        stage: 'task_started',
      });
      this.ui.taskStarted(task, index + 1, plan.tasks.length, routing, policy);

      if (routing.route === 'read_only') {
        this.stats.readOnly += 1;
        this.ui.readOnlyResult(task);
        this.ui.taskCompleted(task, 'read_only');
      } else {
        const outcome = await this.runTask(factory, task, `${index + 1}-${task.id}`, routing);
        if (outcome.route === 'trivial') this.stats.trivial += 1;
        else this.stats.full += 1;
        if (outcome.escalated) this.stats.escalations += 1;
        this.ui.taskCompleted(task, outcome.route);
      }

      await this.saveCheckpoint({
        request: userRequest,
        plan,
        status: 'running',
        nextTaskIndex: index + 1,
        currentTaskIndex: null,
        stage: 'task_complete',
      });
    }

    if (coordinator) await this.usage.refresh(coordinator.usageName, coordinator.session);
    const finalUsage = this.getUsageSummary();
    this.ui.phase('Complete', `All ${plan.tasks.length} task(s) completed under their enforced workflow routes.`);
    this.ui.runSummary(finalUsage, this.stats);
    await this.saveCheckpoint({
      request: userRequest,
      plan,
      status: 'complete',
      nextTaskIndex: plan.tasks.length,
      currentTaskIndex: null,
      stage: 'complete',
    });
    return { plan, usage: finalUsage, stats: { ...this.stats } };
  }
}

module.exports = {
  ResumableConvergentEngine,
};
