'use strict';

const { chooseReasoningEffort, routePolicy } = require('./routing');
const { requireReport } = require('./engine');
const {
  attachEventLogging,
  readonlyHook,
  safeSessionPart,
  withReasoning,
  REVIEWER_TOOLS,
} = require('../copilot/session-factory');

const ARCHITECT_TOOLS = [
  ...REVIEWER_TOOLS.filter((tool) => tool !== 'custom:report_review'),
  'custom:report_architecture',
];

const ARCHITECT_PROMPT = `
You are Convergent's software-architecture specialist for one architecturally significant implementation task. You are read-only. Do not edit files and do not redesign the product beyond the user's request.

Your job is to protect long-term structural quality while actively resisting overengineering:
- prefer the simplest architecture consistent with the requested behavior, existing repository conventions, testability, and likely evolution;
- prefer reuse, deletion, and existing ownership boundaries over a new abstraction;
- recommend a named design/architecture pattern only when it solves a concrete structural problem; never introduce factories, interfaces, plugins, layers, or framework machinery merely because a pattern exists;
- identify the components/interfaces/ownership boundaries actually affected;
- identify constraints the implementer must preserve, including compatibility or migration implications where relevant;
- call out duplicated responsibilities, leaky provider/topology conditionals, circular ownership, premature generic frameworks, or structural drift when evidence supports it;
- it is valid and often preferable to conclude that no architectural intervention is required beyond following existing local patterns.

Inspect only enough repository context to understand the affected boundaries. Keep the result compact. The USER'S REQUEST and acceptance criteria remain authoritative; your assessment is guidance for satisfying them cleanly, not permission to expand scope.

Call report_architecture exactly once when you have enough evidence.
`;

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function list(value, max = 8) {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return values.map(text).filter(Boolean).slice(0, max);
}

function normalizeArchitectureAssessment(args = {}) {
  const intervention = args.intervention === 'constraints' ? 'constraints' : 'none';
  return {
    intervention,
    summary: text(args.summary) || (intervention === 'none'
      ? 'No architectural intervention is required beyond preserving existing repository boundaries.'
      : 'Architecture constraints apply to this task.'),
    affectedBoundaries: list(args.affectedBoundaries),
    constraints: list(args.constraints),
    recommendedApproach: list(args.recommendedApproach),
    patterns: list(args.patterns, 5),
    avoid: list(args.avoid),
  };
}

function createArchitectureTool(defineTool, sink) {
  return defineTool('report_architecture', {
    description: 'Submit a compact read-only software-architecture assessment for the current implementation task. Prefer no intervention when existing local structure is already adequate.',
    parameters: {
      type: 'object',
      properties: {
        intervention: { type: 'string', enum: ['none', 'constraints'] },
        summary: { type: 'string' },
        affectedBoundaries: { type: 'array', maxItems: 8, items: { type: 'string' } },
        constraints: { type: 'array', maxItems: 8, items: { type: 'string' } },
        recommendedApproach: { type: 'array', maxItems: 8, items: { type: 'string' } },
        patterns: { type: 'array', maxItems: 5, items: { type: 'string' }, description: 'Only patterns that solve a concrete structural problem in this task. Empty is preferred when none are needed.' },
        avoid: { type: 'array', maxItems: 8, items: { type: 'string' } },
      },
      required: ['intervention', 'summary', 'affectedBoundaries', 'constraints', 'recommendedApproach', 'patterns', 'avoid'],
      additionalProperties: false,
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args) => {
      sink.value = normalizeArchitectureAssessment(args);
      return { accepted: true, intervention: sink.value.intervention };
    },
  });
}

function formatArchitectureAssessment(assessment) {
  if (!assessment) return '';
  const section = (title, values) => values?.length ? [`${title}:`, ...values.map((value) => `- ${value}`)] : [];
  return [
    'SOFTWARE ARCHITECT ASSESSMENT (read-only advisory; user request and acceptance criteria remain authoritative):',
    `Intervention: ${assessment.intervention}`,
    `Summary: ${assessment.summary}`,
    ...section('Affected boundaries', assessment.affectedBoundaries),
    ...section('Constraints to preserve', assessment.constraints),
    ...section('Recommended structural approach', assessment.recommendedApproach),
    ...section('Applicable patterns only where concretely justified', assessment.patterns),
    ...section('Avoid', assessment.avoid),
    'Do not add abstractions merely to satisfy this assessment. Prefer the smallest implementation that respects these constraints.',
  ].join('\n');
}

function architectureInspectionHints(task) {
  const hints = Array.isArray(task?.inspectionHints)
    ? task.inspectionHints.map(text).filter(Boolean).slice(0, 12)
    : [];
  if (!hints.length) return '';
  return [
    'PLANNING INSPECTION HANDOFF (bounded, non-authoritative):',
    ...hints.map((hint) => `- ${hint}`),
    'The planning coordinator already spent repository-inspection budget identifying these likely relevant surfaces. Start here. Do not repeat broad glob/rg/repository discovery merely to rediscover the same locations; expand only when a specific unresolved architectural question requires it.',
  ].join('\n');
}

function architectureTaskPrompt(task) {
  const inspectionHints = architectureInspectionHints(task);
  return [
    `Task ${task.id}: ${task.title}`,
    '',
    task.description,
    inspectionHints ? '' : null,
    inspectionHints || null,
    '',
    'Acceptance criteria:',
    ...(Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : []).map((criterion) => `- ${criterion}`),
  ].filter((line) => line !== null).join('\n');
}

async function createArchitectureAdvisor(factory, taskId, route, risk) {
  const safeTaskId = safeSessionPart(taskId);
  const sink = { value: null };
  const reportTool = createArchitectureTool(factory.sdk.defineTool, sink);
  const batchView = factory.batchViewTool();
  const model = factory.models.reviewer;
  const desiredEffort = routePolicy(route, risk, route === 'high_risk', 'high').efforts.architect ?? 'medium';
  const effort = chooseReasoningEffort(model, desiredEffort, factory.reasoningMode);
  const sessionId = `${factory.runId}-${safeTaskId}-architect`;
  const name = 'Software architect';
  const session = await factory.client.createSession(withReasoning({
    sessionId,
    clientName: 'convergent-vscode',
    model: model.id,
    workingDirectory: factory.workspace,
    streaming: true,
    tools: [batchView, reportTool],
    availableTools: ARCHITECT_TOOLS,
    systemMessage: { mode: 'append', content: ARCHITECT_PROMPT },
    hooks: { onPreToolUse: (input) => factory.preToolUse(readonlyHook, name, input) },
    onPermissionRequest: factory.permissionHandler,
    onUserInputRequest: factory.userInputHandler,
  }, effort));
  const guard = factory.guard(session, name);
  const usageName = `${safeTaskId}:architect`;
  attachEventLogging(session, name, factory.ui, factory.usage, model, usageName);
  factory.ui.agentTools?.(name, ARCHITECT_TOOLS);
  factory.sessionCreated(name, session, model, effort, ARCHITECT_PROMPT, ARCHITECT_TOOLS, {
    role: 'software-architect', taskId: safeTaskId, route, risk,
  });
  return { session, guard, sink, name, usageName, model, reasoningEffort: effort };
}

async function runArchitectureAssessment(engine, factory, task, routing) {
  const advisor = await createArchitectureAdvisor(factory, task.id, routing.route, routing.risk);
  engine.sessions.push(advisor.session);
  engine.ui?.phase?.('Architecture assessment', `Software architect is checking boundaries and structural constraints for task ${task.id}.`);
  engine.ui?.agentConfiguration?.([{ role: 'Software architect', model: advisor.model.name ?? advisor.model.id, effort: advisor.reasoningEffort }]);
  try {
    const before = await engine.revisionProvider(engine.workspace);
    const startedAt = Date.now();
    const assessment = await requireReport(
      advisor.session,
      advisor.sink,
      [
        architectureTaskPrompt(task),
        '',
        `Task workflow: ${routing.route}; task risk: ${routing.risk}; architecture significance: ${routing.architecture}.`,
        'Inspect the existing architecture only as far as needed to give implementation constraints and the simplest suitable structural approach. Start from the planning handoff when present; do not redo repository discovery that planning already completed. Do not implement the task.',
      ].join('\n'),
      'report_architecture',
      engine.agentTurnTimeoutMs,
    );
    const after = await engine.revisionProvider(engine.workspace);
    await engine.finishTurn(advisor, startedAt);
    if (before !== after) throw new Error('Software architect changed the workspace despite the read-only contract.');
    engine.ui?.log?.(`Software architect assessment for ${task.id}: ${assessment.summary}`);
    engine.ui?.audit?.({ type: 'architecture_assessment', taskId: task.id, architecture: routing.architecture, assessment });
    return assessment;
  } finally {
    await advisor.session.disconnect?.().catch(() => {});
    engine.sessions = engine.sessions.filter((session) => session !== advisor.session);
  }
}

module.exports = {
  ARCHITECT_PROMPT,
  ARCHITECT_TOOLS,
  normalizeArchitectureAssessment,
  createArchitectureTool,
  formatArchitectureAssessment,
  architectureInspectionHints,
  createArchitectureAdvisor,
  runArchitectureAssessment,
};