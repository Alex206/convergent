'use strict';

const base = require('./vscode-ui');

function taskUsageLines(summary) {
  const tasks = Array.isArray(summary?.tasks) ? summary.tasks : [];
  if (!tasks.length) return [];
  const lines = [
    '**Per-task request-lifetime totals**',
    '',
    '| Task | AI credits | In / out | Reasoning | LLM calls | Turns |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const task of tasks) {
    const credits = task.hasCreditData
      ? `≈${Number(task.aiCredits ?? 0).toFixed(Number(task.aiCredits ?? 0) < 0.01 ? 5 : 3)}`
      : 'pending';
    lines.push(`| ${task.taskId} | ${credits} | ${base.formatTokenCount(task.inputTokens)} / ${base.formatTokenCount(task.outputTokens)} | ${base.formatTokenCount(task.reasoningTokens)} | ${task.calls ?? 0} | ${task.turns ?? 0} |`);
  }
  return [...lines, ''];
}

function detailedUsageMarkdown(summary) {
  if (!summary?.run) return base.detailedUsageMarkdown(summary);
  const legacy = base.detailedUsageMarkdown(summary);
  const agentTable = legacy.indexOf('| Agent |');
  const detailTail = agentTable >= 0 ? legacy.slice(agentTable) : legacy;
  return [
    `**Request lifetime total:** ${base.compactUsage(summary)}`,
    `**Current execution total:** ${base.compactUsage(summary.run)}`,
    '',
    ...taskUsageLines(summary),
    detailTail,
  ].join('\n');
}

class VscodeWorkflowUi extends base.VscodeWorkflowUi {
  reviewResult(review, cycle, meta = {}) {
    super.reviewResult(review, cycle, meta);
    if (!meta.cycleUsage) return;
    const cycleSummary = {
      ...meta.cycleUsage,
      elapsedMs: meta.durationMs ?? meta.cycleUsage.elapsedMs,
    };
    const toolCount = Array.isArray(meta.tools) ? meta.tools.length : 0;
    this.stream.markdown(`  ↳ Review cycle ${cycle} current-execution delta: ${base.compactUsage(cycleSummary)}${toolCount ? ` · ${toolCount} reviewer tool call(s)` : ''}\n`);
    this.log(`Review cycle ${cycle} usage [current-execution delta]: ${base.compactUsage(cycleSummary)}; reviewerTools=${toolCount}`);
    this.audit({
      type: 'strong_review_cycle_usage',
      cycle,
      scope: 'current_execution_delta',
      cycleUsage: meta.cycleUsage,
      tools: meta.tools ?? [],
    });
  }

  runSummary(summary, stats = {}) {
    const lines = [
      '',
      '### Run summary',
      '',
      `**Request lifetime total: ${base.compactUsage(summary)}**`,
      '',
      `Tasks: ${stats.tasks ?? 0} · lightweight: ${stats.trivial ?? 0} · full review: ${stats.full ?? 0} · read-only: ${stats.readOnly ?? 0} · escalations: ${stats.escalations ?? 0}`,
      '',
      detailedUsageMarkdown(summary),
      '',
    ];
    this.stream.markdown(lines.join('\n'));
    this.log(`Run summary [request lifetime]: ${base.compactUsage(summary)}; ${JSON.stringify(stats)}`);
  }
}

module.exports = {
  ...base,
  VscodeWorkflowUi,
  detailedUsageMarkdown,
  taskUsageLines,
};
