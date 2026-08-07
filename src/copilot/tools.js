'use strict';

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
      return { accepted: true, taskCount: args.tasks.length };
    },
  });
}

function createPassTool(defineTool, sink) {
  return defineTool('report_pass', {
    description: 'Report the result of the current implementation/review pass. Call exactly once after all edits and checks.',
    parameters: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['clean', 'changed', 'blocked'] },
        summary: { type: 'string' },
        findings: { type: 'array', items: { type: 'string' } },
        checks: { type: 'array', items: { type: 'string' } },
      },
      required: ['verdict', 'summary', 'findings', 'checks'],
      additionalProperties: false,
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args) => {
      sink.value = args;
      return { accepted: true };
    },
  });
}

function createReviewTool(defineTool, sink) {
  return defineTool('report_review', {
    description: 'Submit the strong review verdict and actionable findings. Call exactly once after the complete review.',
    parameters: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['clean', 'findings', 'blocked'] },
        summary: { type: 'string' },
        findings: {
          type: 'array',
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
      sink.value = args;
      return { accepted: true };
    },
  });
}

module.exports = { createPlanTool, createPassTool, createReviewTool };
