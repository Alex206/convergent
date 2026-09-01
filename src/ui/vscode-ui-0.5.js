'use strict';

const base = require('./vscode-ui');

function taskUsageLines(summary) {
  const tasks = Array.isArray(summary?.tasks) ? summary.tasks : [];
  if (!tasks.length) return [];
  const lines = [
    '**Per-task totals (request lifetime)**',
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
  stallControlMap() {
    if (!(this.__convergentStallControls instanceof Map)) this.__convergentStallControls = new Map();
    return this.__convergentStallControls;
  }

  agentHeartbeat(agent, snapshot) {
    const tool = snapshot?.currentTool;
    // Once the operator explicitly chose a wait extension (or while the stall
    // decision itself is pending), keep heartbeats in Output/diagnostics only.
    // Repeating the same "still running" line every two minutes in Chat adds no
    // information and obscures the live controls. The watchdog still re-opens a
    // decision when the selected wait interval expires.
    if (tool && (Number(tool.waitExtendedMs) > 0 || tool.decisionPending)) {
      const detail = `${tool.name}${tool.detail ? ` — ${tool.detail}` : ''} running ${base.formatDuration(tool.elapsedMs)} · no progress ${base.formatDuration(tool.quietMs)}`;
      this.log(`${agent} heartbeat: ${detail}${tool.waitExtendedMs ? ` · operator wait remaining ${base.formatDuration(tool.waitExtendedMs)}` : ' · operator decision pending'}`);
      return;
    }
    return super.agentHeartbeat(agent, snapshot);
  }

  async agentToolStallDecision(agent, snapshot) {
    const tool = snapshot?.currentTool;
    if (tool?.toolCallId) {
      this.stallControlMap().set(agent, {
        toolCallId: String(tool.toolCallId),
        tool: String(tool.name ?? ''),
      });
    }
    const decision = await super.agentToolStallDecision(agent, snapshot);
    if (decision?.action !== 'continue') this.stallControlMap().delete(agent);
    return decision;
  }

  agentToolWaitExtended(agent, tool, waitMs) {
    super.agentToolWaitExtended(agent, tool, waitMs);
    const control = this.stallControlMap().get(agent);
    if (!/(^|:)run[_-]?command$/i.test(String(tool ?? '')) || !control?.toolCallId || typeof this.stream?.button !== 'function') return;
    this.stream.button({
      command: 'convergent.terminateManagedCommand',
      title: 'Terminate command & recover now',
      arguments: [agent, control.toolCallId, ''],
    });
    this.log(`${agent}: live managed-command termination control retained during the ${base.formatDuration(waitMs)} wait extension; toolCallId=${control.toolCallId}.`);
  }

  agentToolComplete(agent, tool, durationMs, success) {
    // Copilot's tool.execution_complete success bit describes whether the tool
    // handler itself returned normally. For run_command that is deliberately
    // independent from the child process exit code: a managed command may
    // return an exact exitCode=1 result through a successful tool invocation.
    // The managed lifecycle already renders/logs the authoritative state/exit,
    // so suppress this redundant generic line instead of printing a misleading
    // "run_command ... success" beside "managed command exit 1".
    if (/(^|:)run[_-]?command$/i.test(String(tool ?? ''))) {
      this.stallControlMap().delete(agent);
      return;
    }
    return super.agentToolComplete(agent, tool, durationMs, success);
  }

  agentToolStalled(agent, tool, elapsedMs, diagnostic) {
    this.stallControlMap().delete(agent);
    return super.agentToolStalled(agent, tool, elapsedMs, diagnostic);
  }

  reviewResult(review, cycle, meta = {}) {
    super.reviewResult(review, cycle, meta);
    if (!meta.cycleUsage) return;
    const cycleSummary = {
      ...meta.cycleUsage,
      elapsedMs: meta.durationMs ?? meta.cycleUsage.elapsedMs,
    };
    const toolCount = Array.isArray(meta.tools) ? meta.tools.length : 0;
    this.stream.markdown(`  ↳ Cycle ${cycle} usage [current-execution delta]: ${base.compactUsage(cycleSummary)}${toolCount ? ` · ${toolCount} reviewer tool call(s)` : ''}\n`);
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
