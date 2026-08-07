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

function createPlanTool(defineTool, sink) {
  return defineTool('report_plan', {
    description: 'Submit the final structured plan and per-task workflow classification to the Convergent orchestrator. Call exactly once.',
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
              routingReason: { type: 'string' },
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
      sink.value = args;
      return { accepted: true, taskCount: Array.isArray(args?.tasks) ? args.tasks.length : 0 };
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

module.exports = {
  createPlanTool,
  createPassTool,
  createReviewTool,
  normalizeStringList,
  normalizePassReport,
  validatePassReport,
  normalizeReviewReport,
  validateReviewReport,
};
