'use strict';

function toText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    if (typeof value.description === 'string' && typeof value.title === 'string') {
      return `${value.title}: ${value.description}`;
    }
    if (typeof value.description === 'string') return value.description;
    if (typeof value.message === 'string') return value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function normalizeStringList(value) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(toText).map((item) => item.trim()).filter(Boolean);
}

function normalizePlanTask(value = {}) {
  const task = value && typeof value === 'object' ? value : {};
  return {
    id: toText(task.id).trim(),
    title: toText(task.title).trim(),
    description: toText(task.description).trim(),
    acceptanceCriteria: normalizeStringList(task.acceptanceCriteria),
    route: toText(task.route).trim(),
    risk: toText(task.risk).trim(),
    architectureSignificance: toText(task.architectureSignificance).trim(),
    routingReason: toText(task.routingReason).trim(),
    inspectionHints: normalizeStringList(task.inspectionHints).slice(0, 12),
    result: toText(task.result).trim(),
  };
}

function normalizePlan(args = {}) {
  const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
  return {
    summary: toText(args.summary).trim(),
    tasks: rawTasks.map(normalizePlanTask),
  };
}

function validatePlan(plan) {
  const routes = new Set(['read_only', 'trivial', 'standard', 'high_risk']);
  const risks = new Set(['low', 'medium', 'high']);
  const architectureSignificances = new Set(['low', 'medium', 'high']);
  if (!plan.summary) return 'Plan summary is required.';
  if (!plan.tasks.length) return 'Plan requires at least one task.';

  const seenIds = new Set();
  for (let index = 0; index < plan.tasks.length; index += 1) {
    const task = plan.tasks[index];
    const label = task.id || `task ${index + 1}`;
    if (!task.id) return `Task ${index + 1} requires a non-empty id.`;
    if (seenIds.has(task.id)) return `Task id '${task.id}' is duplicated.`;
    seenIds.add(task.id);
    if (!task.title) return `Task '${label}' requires a non-empty title.`;
    if (!task.description) return `Task '${label}' requires a non-empty description.`;
    if (!task.acceptanceCriteria.length) {
      return `Task '${label}' requires acceptanceCriteria as a non-empty top-level array. Do not embed AcceptanceCriteria text inside description.`;
    }
    if (!routes.has(task.route)) {
      return `Task '${label}' requires top-level route to be one of read_only, trivial, standard, high_risk.`;
    }
    if (!risks.has(task.risk)) {
      return `Task '${label}' requires top-level risk to be one of low, medium, high.`;
    }
    if (task.architectureSignificance && !architectureSignificances.has(task.architectureSignificance)) {
      return `Task '${label}' architectureSignificance must be one of low, medium, high when provided.`;
    }
    if (!task.routingReason) {
      return `Task '${label}' requires a non-empty top-level routingReason.`;
    }
    if (task.route === 'read_only' && !task.result) {
      return `Read-only task '${label}' requires a completed top-level result; planning inspection must not be deferred as a later task.`;
    }
  }
  return null;
}

function normalizePassReport(args = {}) {
  const allowedVerdicts = new Set(['clean', 'changed', 'blocked']);
  const verdict = allowedVerdicts.has(args.verdict) ? args.verdict : 'blocked';
  return {
    verdict,
    summary: toText(args.summary).trim() || (verdict === 'blocked' ? 'Agent returned an invalid structured verdict.' : ''),
    findings: normalizeStringList(args.findings),
    checks: normalizeStringList(args.checks),
  };
}

function validatePassReport(report) {
  if ((report.verdict === 'clean' || report.verdict === 'changed') && report.findings.length) {
    return `${report.verdict.toUpperCase()} requires findings=[] because findings are reserved for unresolved actionable issues. Put resolved issues, peer disagreements, and non-actionable observations in summary.`;
  }
  return null;
}

function normalizeReviewFinding(value) {
  if (typeof value === 'string') {
    return { severity: 'medium', title: 'Review finding', description: value };
  }
  const finding = value && typeof value === 'object' ? value : {};
  const allowedSeverities = new Set(['critical', 'high', 'medium', 'low']);
  const description = toText(finding.description ?? finding.message ?? value).trim();
  return {
    severity: allowedSeverities.has(finding.severity) ? finding.severity : 'medium',
    title: toText(finding.title).trim() || 'Review finding',
    description: description || 'Reviewer returned a finding without a description.',
    ...(finding.file ? { file: toText(finding.file).trim() } : {}),
  };
}

function normalizeReviewReport(args = {}) {
  const allowedVerdicts = new Set(['clean', 'findings', 'blocked']);
  const verdict = allowedVerdicts.has(args.verdict) ? args.verdict : 'blocked';
  const rawFindings = args.findings === undefined || args.findings === null || args.findings === ''
    ? []
    : Array.isArray(args.findings) ? args.findings : [args.findings];
  return {
    verdict,
    summary: toText(args.summary).trim() || (verdict === 'blocked' ? 'Reviewer returned an invalid structured verdict.' : ''),
    findings: rawFindings.map(normalizeReviewFinding),
    checks: normalizeStringList(args.checks),
  };
}

function validateReviewReport(report) {
  if (report.verdict === 'clean' && report.findings.length) {
    return 'CLEAN requires findings=[]. Put resolved/non-actionable observations in summary.';
  }
  if (report.verdict === 'findings' && !report.findings.length) {
    return 'FINDINGS requires at least one actionable finding.';
  }
  return null;
}

function normalizeRecoveryReport(args = {}) {
  const allowedActions = new Set(['peer', 'retry', 'ask_user', 'pause']);
  const action = allowedActions.has(args.action) ? args.action : 'pause';
  return {
    action,
    rationale: toText(args.rationale).trim() || 'No recovery rationale was provided.',
    question: toText(args.question).trim(),
    guidance: toText(args.guidance).trim(),
  };
}

function validateRecoveryReport(report) {
  if (report.action === 'ask_user' && !report.question) {
    return 'ASK_USER requires a concrete question for the operator.';
  }
  return null;
}

function decodeXmlText(value) {
  return String(value ?? '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .trim();
}

function lastXmlBlock(text, rootTag) {
  const source = String(text ?? '');
  const pattern = new RegExp(`<${rootTag}\\b[^>]*>([\\s\\S]*?)<\\/${rootTag}>`, 'gi');
  let match;
  let last = null;
  while ((match = pattern.exec(source)) !== null) last = match[1];
  return last;
}

function xmlTag(block, tagName) {
  const match = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i').exec(String(block ?? ''));
  return match ? decodeXmlText(match[1]) : null;
}

function parseSerializedList(value) {
  if (value === null || value === undefined) return null;
  const text = decodeXmlText(value);
  if (!text || text === '[]') return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to bullet/newline parsing.
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ''))
    .filter(Boolean);
}

function recoverPassReportFromText(content) {
  const block = lastXmlBlock(content, 'report_pass');
  if (block === null) return null;
  const verdict = xmlTag(block, 'verdict');
  const summary = xmlTag(block, 'summary');
  const findings = parseSerializedList(xmlTag(block, 'findings'));
  const checks = parseSerializedList(xmlTag(block, 'checks'));
  if (verdict === null || summary === null || findings === null || checks === null) return null;

  const report = normalizePassReport({
    verdict: verdict.toLowerCase(),
    summary,
    findings,
    checks,
  });
  return validatePassReport(report) ? null : report;
}

function recoverReviewReportFromText(content) {
  const block = lastXmlBlock(content, 'report_review');
  if (block === null) return null;
  const verdict = xmlTag(block, 'verdict');
  const summary = xmlTag(block, 'summary');
  const findingsText = xmlTag(block, 'findings');
  const checks = parseSerializedList(xmlTag(block, 'checks'));
  if (verdict === null || summary === null || findingsText === null || checks === null) return null;

  let findings = [];
  const findingBlocks = [...String(findingsText).matchAll(/<finding\b[^>]*>([\s\S]*?)<\/finding>/gi)];
  if (findingBlocks.length) {
    findings = findingBlocks.map((match) => ({
      severity: (xmlTag(match[1], 'severity') ?? 'medium').toLowerCase(),
      title: xmlTag(match[1], 'title') ?? 'Review finding',
      description: xmlTag(match[1], 'description') ?? '',
      ...(xmlTag(match[1], 'file') ? { file: xmlTag(match[1], 'file') } : {}),
    }));
  } else {
    findings = parseSerializedList(findingsText) ?? [];
  }

  const report = normalizeReviewReport({
    verdict: verdict.toLowerCase(),
    summary,
    findings,
    checks,
  });
  return validateReviewReport(report) ? null : report;
}

function recoverSerializedReport(content, toolName) {
  if (toolName === 'report_pass') return recoverPassReportFromText(content);
  if (toolName === 'report_review') return recoverReviewReportFromText(content);
  return null;
}

function createPlanTool(defineTool, sink) {
  return defineTool('report_plan', {
    description: 'Submit the final structured plan and per-task workflow classification to the Convergent orchestrator. Call exactly once with every required task field as a real top-level JSON property, not embedded in description text.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              acceptanceCriteria: { type: 'array', items: { type: 'string' }, minItems: 1 },
              route: { type: 'string', enum: ['read_only', 'trivial', 'standard', 'high_risk'] },
              risk: { type: 'string', enum: ['low', 'medium', 'high'] },
              architectureSignificance: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
                description: 'Structural significance independent from failure impact/risk. Use high only for subsystem/boundary/interface/ownership changes that justify a read-only software architect specialist.',
              },
              routingReason: { type: 'string' },
              inspectionHints: {
                type: 'array',
                maxItems: 12,
                items: { type: 'string' },
                description: 'Optional bounded non-authoritative repository-relative EXISTING files, paths, symbols, or tests actually observed during planning. Do not put proposed/new files here; those belong in description or acceptance criteria. These are Worker A starting locators, not transcript/tool output.',
              },
              result: {
                type: 'string',
                description: 'Required for read_only tasks: the coordinator answer/result after performing the necessary inspection.',
              },
            },
            required: ['id', 'title', 'description', 'acceptanceCriteria', 'route', 'risk', 'routingReason'],
            additionalProperties: false,
          },
        },
      },
      required: ['summary', 'tasks'],
      additionalProperties: false,
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args) => {
      const plan = normalizePlan(args);
      const error = validatePlan(plan);
      if (error) return { accepted: false, error, retry: true };
      sink.value = plan;
      return { accepted: true, taskCount: plan.tasks.length };
    },
  });
}

function createPassTool(defineTool, sink) {
  return defineTool('report_pass', {
    description: 'Report the final state of the current implementation/review pass. findings means unresolved actionable issues only; resolved issues and peer disagreements belong in summary.',
    parameters: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['clean', 'changed', 'blocked'] },
        summary: {
          type: 'string',
          description: 'Concise technical result. Include changes made, resolved issues, and disagreements with the peer here.',
        },
        findings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Unresolved actionable issues remaining after this pass. MUST be [] for CLEAN and CHANGED. If a required issue cannot be resolved safely, use BLOCKED.',
        },
        checks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relevant validation/checks actually performed.',
        },
      },
      required: ['verdict', 'summary', 'findings', 'checks'],
      additionalProperties: false,
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args) => {
      const report = normalizePassReport(args);
      const error = validatePassReport(report);
      if (error) return { accepted: false, error, retry: true };
      sink.value = report;
      return { accepted: true };
    },
  });
}

function createReviewTool(defineTool, sink) {
  return defineTool('report_review', {
    description: 'Submit the strong review verdict and unresolved actionable findings. Call exactly once after the complete review.',
    parameters: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['clean', 'findings', 'blocked'] },
        summary: { type: 'string' },
        findings: {
          type: 'array',
          description: 'Unresolved actionable findings. MUST be [] for CLEAN and non-empty for FINDINGS.',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
              title: { type: 'string' },
              description: { type: 'string' },
              file: { type: 'string' },
            },
            required: ['severity', 'title', 'description'],
            additionalProperties: false,
          },
        },
        checks: { type: 'array', items: { type: 'string' } },
      },
      required: ['verdict', 'summary', 'findings', 'checks'],
      additionalProperties: false,
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args) => {
      const report = normalizeReviewReport(args);
      const error = validateReviewReport(report);
      if (error) return { accepted: false, error, retry: true };
      sink.value = report;
      return { accepted: true };
    },
  });
}

function createRecoveryTool(defineTool, sink) {
  return defineTool('report_recovery', {
    description: 'Choose the next deterministic recovery action for a blocked Convergent worker/reviewer. Do not implement or edit the task.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['peer', 'retry', 'ask_user', 'pause'] },
        rationale: { type: 'string' },
        question: {
          type: 'string',
          description: 'Required only for ask_user: one concrete question the operator can answer in free text.',
        },
        guidance: {
          type: 'string',
          description: 'Concise instruction/context to inject into the selected agent on retry/peer continuation.',
        },
      },
      required: ['action', 'rationale', 'question', 'guidance'],
      additionalProperties: false,
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args) => {
      const report = normalizeRecoveryReport(args);
      const error = validateRecoveryReport(report);
      if (error) return { accepted: false, error, retry: true };
      sink.value = report;
      return { accepted: true };
    },
  });
}

module.exports = {
  createPlanTool,
  createPassTool,
  createReviewTool,
  createRecoveryTool,
  normalizeStringList,
  normalizePlanTask,
  normalizePlan,
  validatePlan,
  normalizePassReport,
  validatePassReport,
  normalizeReviewReport,
  validateReviewReport,
  normalizeRecoveryReport,
  validateRecoveryReport,
  recoverPassReportFromText,
  recoverReviewReportFromText,
  recoverSerializedReport,
};
