'use strict';

function formatDuration(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function formatTokenCount(value) {
  const number = Number(value) || 0;
  if (number < 1000) return String(Math.round(number));
  if (number < 1_000_000) return `${(number / 1000).toFixed(number < 10_000 ? 1 : 0)}k`;
  return `${(number / 1_000_000).toFixed(1)}m`;
}

function formatCredits(summary) {
  if (!summary?.hasCreditData) return 'AI credits pending';
  return `≈${summary.aiCredits.toFixed(summary.aiCredits < 0.01 ? 5 : 3)} AI credits`;
}

function compactUsage(summary) {
  if (!summary) return '';
  const tokens = (summary.inputTokens ?? 0) + (summary.outputTokens ?? 0);
  return `${formatCredits(summary)} · ${formatTokenCount(tokens)} tokens · ${summary.turns ?? 0} turns · ${formatDuration(summary.elapsedMs)}`;
}

function aggregateAgentUsage(summary) {
  const groups = new Map();
  for (const entry of summary?.agents ?? []) {
    const key = `${entry.label}|${entry.model}`;
    const group = groups.get(key) ?? {
      label: entry.label,
      model: entry.model,
      aiCredits: 0,
      hasCreditData: false,
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
      durationMs: 0,
    };
    group.aiCredits += entry.aiCredits ?? 0;
    group.hasCreditData ||= Boolean(entry.hasCreditData);
    group.inputTokens += entry.inputTokens ?? 0;
    group.outputTokens += entry.outputTokens ?? 0;
    group.turns += entry.turns ?? 0;
    group.durationMs += entry.durationMs ?? 0;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function detailedUsageMarkdown(summary) {
  const lines = [
    `**Usage:** ${compactUsage(summary)}`,
    '',
    '| Agent | Model | AI credits | Tokens in/out | Turns | Active time |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  ];
  for (const entry of aggregateAgentUsage(summary)) {
    const credits = entry.hasCreditData ? `≈${entry.aiCredits.toFixed(entry.aiCredits < 0.01 ? 5 : 3)}` : 'pending';
    lines.push(`| ${entry.label} | ${entry.model} | ${credits} | ${formatTokenCount(entry.inputTokens)}/${formatTokenCount(entry.outputTokens)} | ${entry.turns} | ${formatDuration(entry.durationMs)} |`);
  }
  lines.push('', '_AI credits are derived from Copilot nano-AIU usage (nano-AIU ÷ 1e9); GitHub billing remains the source of truth._');
  return lines.join('\n');
}

class VscodeWorkflowUi {
  constructor(vscode, stream, output) {
    this.vscode = vscode;
    this.stream = stream;
    this.output = output;
    this.lastUsageLogAt = 0;
  }

  log(message) {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  phase(name, detail) {
    this.stream.progress(`${name}: ${detail}`);
    this.log(`${name}: ${detail}`);
  }

  plan(plan, routes = []) {
    const lines = ['### Plan', '', plan.summary, ''];
    plan.tasks.forEach((task, index) => {
      const routing = routes[index];
      const badge = routing ? ` · \`${routing.route}\` · risk \`${routing.risk}\`` : '';
      lines.push(`${index + 1}. **${task.title}**${badge} — ${task.description}`);
    });
    lines.push('');
    this.stream.markdown(lines.join('\n'));
    this.log(`Plan accepted with ${plan.tasks.length} task(s).`);
  }

  taskStarted(task, index, total, routing, policy) {
    this.stream.markdown(`\n### Task ${index}/${total}: ${task.title}\n`);
    this.stream.markdown(`**Route:** \`${routing.route}\` · **risk:** \`${routing.risk}\` — ${policy.description}\n`);
    if (routing.reason) this.stream.markdown(`_${routing.reason}_\n`);
    this.stream.progress(`${task.title}: ${routing.route} workflow starting`);
    this.log(`Task ${task.id} started: ${task.title}; route=${routing.route}; risk=${routing.risk}; reason=${routing.reason}`);
  }

  agentConfiguration(entries) {
    const text = entries
      .filter(Boolean)
      .map((entry) => `${entry.role}: ${entry.model}${entry.effort ? ` (${entry.effort} effort)` : ''}`)
      .join(' · ');
    if (text) {
      this.stream.progress(text);
      this.log(`Agent configuration: ${text}`);
    }
  }

  agentTools(agent, tools) {
    this.log(`${agent} available tools: ${(tools ?? []).join(', ')}`);
  }

  readOnlyResult(task) {
    this.stream.markdown(`\n${task.result}\n`);
    this.log(`Read-only task ${task.id} answered by coordinator.`);
  }

  taskCompleted(task, route) {
    const detail = route === 'read_only'
      ? 'completed by coordinator inspection'
      : route === 'trivial'
        ? 'passed lightweight implementer + peer review'
        : 'passed A/B convergence and strong review';
    this.stream.markdown(`✓ **${task.title}** ${detail}.\n`);
    this.log(`Task ${task.id} completed via ${route}.`);
  }

  passResult(worker, report, changed, revision, meta = {}) {
    const mark = report.verdict === 'clean' ? '✓' : report.verdict === 'blocked' ? '⛔' : '↻';
    const state = changed ? 'changed workspace' : report.verdict;
    const duration = meta.durationMs !== undefined ? ` · ${formatDuration(meta.durationMs)}` : '';
    this.stream.markdown(`${mark} Worker ${worker}: **${state}**${duration} — ${report.summary}\n`);
    this.log(`Worker ${worker}: ${report.verdict}, changed=${changed}, revision=${revision.slice(0, 12)}, duration=${meta.durationMs ?? 0}ms; ${report.summary}`);
    if (meta.usage) this.usageProgress(meta.usage);
  }

  converged(revision, pass) {
    this.stream.markdown(`✓ Workers A and B both approved revision \`${revision.slice(0, 12)}\` after ${pass} review/fix pass(es).\n`);
    this.log(`Workers converged on ${revision} after ${pass} pass(es).`);
  }

  reviewResult(review, cycle, meta = {}) {
    const duration = meta.durationMs !== undefined ? ` · ${formatDuration(meta.durationMs)}` : '';
    if (review.verdict === 'clean') {
      this.stream.markdown(`✓ Strong reviewer cycle ${cycle}: **CLEAN**${duration} — ${review.summary}\n`);
    } else {
      this.stream.markdown(`⚠ Strong reviewer cycle ${cycle}: **${review.verdict.toUpperCase()}**${duration} — ${review.summary}\n`);
      for (const finding of review.findings ?? []) {
        this.stream.markdown(`  - **${finding.severity}** ${finding.title}${finding.file ? ` — \`${finding.file}\`` : ''}\n`);
      }
    }
    this.log(`Strong reviewer cycle ${cycle}: ${review.verdict}, duration=${meta.durationMs ?? 0}ms; ${review.summary}`);
    if (meta.usage) this.usageProgress(meta.usage);
  }

  escalated(from, to, reason) {
    this.stream.markdown(`↗ **Workflow escalated:** \`${from}\` → \`${to}\` — ${reason}\n`);
    this.stream.progress(`Escalated to ${to}: ${reason}`);
    this.log(`Workflow escalated ${from} -> ${to}: ${reason}`);
  }

  usageProgress(summary) {
    this.stream.progress(`Usage so far: ${compactUsage(summary)}`);
    this.log(`Usage: ${compactUsage(summary)}`);
  }

  runSummary(summary, stats = {}) {
    const lines = [
      '',
      '### Run summary',
      '',
      `**${compactUsage(summary)}**`,
      '',
      `Tasks: ${stats.tasks ?? 0} · lightweight: ${stats.trivial ?? 0} · full review: ${stats.full ?? 0} · read-only: ${stats.readOnly ?? 0} · escalations: ${stats.escalations ?? 0}`,
      '',
      detailedUsageMarkdown(summary),
      '',
    ];
    this.stream.markdown(lines.join('\n'));
    this.log(`Run summary: ${compactUsage(summary)}; ${JSON.stringify(stats)}`);
  }

  agentIntent(agent, intent) {
    if (intent) this.stream.progress(`${agent}: ${intent}`);
    this.log(`${agent} intent: ${intent ?? ''}`);
  }

  agentTool(agent, tool) {
    this.log(`${agent} tool: ${tool}`);
  }

  agentMessage(agent, content) {
    if (content) this.log(`${agent}: ${content}`);
  }

  agentUsageEvent(agent, summary) {
    const now = Date.now();
    if (now - this.lastUsageLogAt > 1500) {
      this.log(`${agent} usage checkpoint: ${compactUsage(summary)}`);
      this.lastUsageLogAt = now;
    }
  }

  agentError(agent, message) {
    this.log(`${agent} ERROR: ${message}`);
  }
}

module.exports = {
  VscodeWorkflowUi,
  formatDuration,
  compactUsage,
  detailedUsageMarkdown,
};
