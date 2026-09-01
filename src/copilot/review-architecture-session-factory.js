'use strict';

const {
  SessionFactory,
  attachEventLogging,
  readonlyHook,
  safeSessionPart,
  withReasoning,
  REVIEWER_TOOLS,
} = require('./session-factory');
const { REVIEWER_PROMPT } = require('../orchestrator/prompts');
const { reviewerFlowInstructions } = require('../orchestrator/flow');
const { routePolicy, chooseReasoningEffort } = require('../orchestrator/routing');
const { workspaceScopePrompt } = require('../orchestrator/workspace-scope');
const { resolvedModel } = require('../orchestrator/model-resolver');
const { createReviewTool } = require('./tools');
const {
  normalizeReviewArchitecture,
  reviewerSpecs,
  aggregateReviewReports,
} = require('../orchestrator/review-architecture');

function modelText(model) {
  return `${model?.id ?? ''} ${model?.name ?? ''}`.trim();
}

function resolveLunaReviewerModel(models = []) {
  const match = models.find((model) => /gpt[- ]?5\.6.*luna/i.test(modelText(model)));
  if (!match) {
    throw new Error('The selected R2/R3 review architecture requires GPT-5.6 Luna, but no Luna model is available from Copilot model discovery. Choose R1 (terra-single) or make Luna available.');
  }
  return resolvedModel(match, 'review architecture requires GPT-5.6 Luna');
}

async function sendMemberReview(member, options, timeoutMs) {
  member.sink.value = null;
  try {
    await member.session.sendAndWait(options, timeoutMs);
  } catch (error) {
    if (member.sink.value) {
      await member.session.abort?.().catch(() => {});
    } else {
      throw error;
    }
  }

  if (!member.sink.value) {
    try {
      await member.session.sendAndWait({
        ...options,
        prompt: [
          options?.prompt ?? '',
          '',
          'You did not call report_review with an accepted result. Do not perform more exploration. Complete this review pass now and call report_review exactly once with a semantically valid final structured result.',
        ].join('\n'),
      }, timeoutMs);
    } catch (error) {
      if (member.sink.value) await member.session.abort?.().catch(() => {});
      else throw error;
    }
  }
  if (!member.sink.value) throw new Error(`${member.label} failed to call report_review with an accepted result after a retry.`);
  return member.sink.value;
}

function compositeGuard(panelLabel, members, state) {
  return {
    agentName: panelLabel,
    activeRejectors: state.activeRejectors,
    async rawSend(options) {
      const active = state.activeMember;
      const guard = active?.session?.__convergentGuard;
      if (typeof guard?.rawSend !== 'function') throw new Error('No panel reviewer turn is currently active for steering.');
      return guard.rawSend(options);
    },
    snapshot() {
      const snapshots = members
        .map((member) => member.session?.__convergentGuard?.snapshot?.())
        .filter(Boolean);
      return {
        agentName: panelLabel,
        reviewPanel: true,
        active: state.activeRejectors.size > 0,
        activeMember: state.activeMember?.label ?? null,
        panelMembers: snapshots,
      };
    },
  };
}

function createCompositeReviewer(factory, taskId, architecture, members, aggregateSink, sessionAttempt = '') {
  const safeTaskId = safeSessionPart(taskId);
  const state = {
    activeMember: null,
    activeRejectors: new Set(),
    lastReports: [],
  };
  const panelLabel = `${architecture.benchmarkId} ${architecture.label}`;
  const sessionId = `${factory.runId}-${safeTaskId}-review-panel-${architecture.id}${sessionAttempt ? `-${safeSessionPart(sessionAttempt)}` : ''}`;

  const session = {
    sessionId,
    async sendAndWait(options, timeoutMs) {
      const token = {};
      state.activeRejectors.add(token);
      const reports = [];
      aggregateSink.value = null;
      try {
        for (const member of members) {
          state.activeMember = member;
          const startedAt = Date.now();
          const report = await sendMemberReview(member, options, timeoutMs);
          factory.usage?.recordTurn(member.usageName, Date.now() - startedAt);
          await factory.usage?.refresh(member.usageName, member.session);
          reports.push({
            id: member.reviewSpec.id,
            label: member.label,
            report,
          });
          factory.ui?.log?.(`${member.label} -> ${String(report.verdict ?? '').toUpperCase()}${report.findings?.length ? ` (${report.findings.length} finding(s))` : ''}.`);
          try {
            void factory.ui?.auditEvent?.({
              type: 'review_panel_member_result',
              architecture: architecture.id,
              benchmarkId: architecture.benchmarkId,
              reviewerId: member.reviewSpec.id,
              reviewerLabel: member.label,
              verdict: report.verdict,
              findings: report.findings ?? [],
              checks: report.checks ?? [],
              summary: report.summary ?? '',
            });
          } catch {}
        }
        state.lastReports = reports;
        aggregateSink.value = aggregateReviewReports(reports, architecture.id);
        return { reviewArchitecture: architecture.id, reports };
      } finally {
        state.activeMember = null;
        state.activeRejectors.delete(token);
      }
    },
    async abort() {
      await Promise.allSettled(members.map((member) => member.session.abort?.()));
    },
    async disconnect() {
      await Promise.allSettled(members.map((member) => member.session.disconnect?.()));
    },
  };
  session.__convergentGuard = compositeGuard(panelLabel, members, state);
  session.__convergentReviewMembers = members;
  session.__convergentReviewArchitecture = architecture.id;

  return {
    session,
    guard: session.__convergentGuard,
    sink: aggregateSink,
    name: panelLabel,
    usageName: null,
    model: {
      id: `review-panel:${architecture.id}`,
      name: `${architecture.reviewerCount}× GPT-5.6 Luna`,
      reason: `${architecture.benchmarkId} ${architecture.label}`,
    },
    reasoningEffort: members[0]?.reasoningEffort,
    architecture,
    members,
  };
}

class ReviewArchitectureSessionFactory extends SessionFactory {
  async createPanelMember(taskId, route, risk, architecture, spec, sessionAttempt = '') {
    const safeTaskId = safeSessionPart(taskId);
    const attemptSuffix = sessionAttempt ? `-${safeSessionPart(sessionAttempt)}` : '';
    const sink = { value: null };
    const tool = createReviewTool(this.sdk.defineTool, sink);
    const batchView = this.batchViewTool();
    const label = spec.label;
    let guard = null;
    const runCommand = this.runCommandTool(label, () => guard);
    const model = resolveLunaReviewerModel(this.models.available ?? []);
    const desiredEffort = routePolicy(route, risk).efforts.reviewer;
    const effort = chooseReasoningEffort(model, desiredEffort, this.reasoningMode);
    const baselinePrompt = await this.taskBaselinePrompt(taskId);
    const systemPrompt = [
      REVIEWER_PROMPT,
      reviewerFlowInstructions(this.flowMode),
      spec.prompt,
      this.explorationPrompt(),
      workspaceScopePrompt(this.workspace, this.workspaceFolders),
      baselinePrompt,
    ].filter(Boolean).join('\n\n');
    const session = await this.client.createSession(withReasoning({
      sessionId: `${this.runId}-${safeTaskId}-reviewer-${safeSessionPart(spec.id)}${attemptSuffix}`,
      clientName: 'convergent-vscode',
      model: model.id,
      workingDirectory: this.workspace,
      streaming: true,
      tools: [batchView, runCommand, tool],
      availableTools: REVIEWER_TOOLS,
      customAgents: [this.exploreAgent()],
      systemMessage: { mode: 'append', content: systemPrompt },
      hooks: {
        // Keep deterministic reviewer-integrity reconciliation under the existing
        // shared Strong reviewer credential-violation scope while preserving a
        // distinct UI/audit label for each panel member.
        onPreToolUse: (input) => this.preToolUse(readonlyHook, 'Strong reviewer', input),
      },
      onPermissionRequest: this.permissionHandler,
      onUserInputRequest: this.userInputHandler,
    }, effort));
    guard = this.guard(session, label);
    const usageKey = `${safeTaskId}:reviewer-${safeSessionPart(spec.id)}${attemptSuffix}`;
    attachEventLogging(session, label, this.ui, this.usage, model, usageKey, { sink, toolName: 'report_review' });
    this.ui.agentTools?.(label, REVIEWER_TOOLS);
    this.sessionCreated(label, session, model, effort, systemPrompt, REVIEWER_TOOLS, {
      role: 'reviewer',
      reviewArchitecture: architecture.id,
      reviewBenchmarkId: architecture.benchmarkId,
      reviewSpec: spec.id,
      reviewFocus: spec.focus,
      taskId: safeTaskId,
      route,
      risk,
      sessionAttempt: sessionAttempt || null,
      exploreAgent: this.exploreAgent(),
    });
    return {
      session,
      guard,
      sink,
      name: label,
      label,
      usageName: usageKey,
      model,
      reasoningEffort: effort,
      reviewSpec: spec,
      architecture,
    };
  }

  async createReviewer(taskId, route = 'standard', risk = 'medium', sessionAttempt = '') {
    const architecture = normalizeReviewArchitecture(this.reviewArchitecture);
    if (architecture.id === 'terra-single') {
      const reviewer = await SessionFactory.prototype.createReviewer.call(this, taskId, route, risk, sessionAttempt);
      reviewer.architecture = architecture;
      reviewer.reviewSpec = reviewerSpecs(architecture.id)[0];
      return reviewer;
    }

    const members = [];
    for (const spec of reviewerSpecs(architecture.id)) {
      members.push(await this.createPanelMember(taskId, route, risk, architecture, spec, sessionAttempt));
    }
    const aggregateSink = { value: null };
    return createCompositeReviewer(this, taskId, architecture, members, aggregateSink, sessionAttempt);
  }
}

module.exports = {
  ReviewArchitectureSessionFactory,
  resolveLunaReviewerModel,
  sendMemberReview,
  createCompositeReviewer,
};
