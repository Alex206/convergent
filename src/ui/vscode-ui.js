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

function compactActivity(value, max = 420) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      maxContextTokens: 0,
      maxContextMessages: 0,
      turns: 0,
      calls: 0,
      durationMs: 0,
    };
    group.aiCredits += entry.aiCredits ?? 0;
    group.hasCreditData ||= Boolean(entry.hasCreditData);
    group.inputTokens += entry.inputTokens ?? 0;
    group.outputTokens += entry.outputTokens ?? 0;
    group.reasoningTokens += entry.reasoningTokens ?? 0;
    group.cacheReadTokens += entry.cacheReadTokens ?? 0;
    group.cacheWriteTokens += entry.cacheWriteTokens ?? 0;
    group.maxContextTokens = Math.max(group.maxContextTokens, entry.maxContextTokens ?? 0);
    group.maxContextMessages = Math.max(group.maxContextMessages, entry.maxContextMessages ?? 0);
    group.turns += entry.turns ?? 0;
    group.calls += entry.calls ?? 0;
    group.durationMs += entry.durationMs ?? 0;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function detailedUsageMarkdown(summary) {
  const lines = [
    `**Usage:** ${compactUsage(summary)}`,
    '',
    '| Agent | Model | AI credits | In / out | Cache read / write | Reasoning | LLM calls | Peak context | Turns | Active time |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const entry of aggregateAgentUsage(summary)) {
    const credits = entry.hasCreditData ? `≈${entry.aiCredits.toFixed(entry.aiCredits < 0.01 ? 5 : 3)}` : 'pending';
    const context = entry.maxContextTokens
      ? `${formatTokenCount(entry.maxContextTokens)}${entry.maxContextMessages ? ` / ${entry.maxContextMessages} msg` : ''}`
      : 'n/a';
    lines.push(`| ${entry.label} | ${entry.model} | ${credits} | ${formatTokenCount(entry.inputTokens)} / ${formatTokenCount(entry.outputTokens)} | ${formatTokenCount(entry.cacheReadTokens)} / ${formatTokenCount(entry.cacheWriteTokens)} | ${formatTokenCount(entry.reasoningTokens)} | ${entry.calls} | ${context} | ${entry.turns} | ${formatDuration(entry.durationMs)} |`);
  }
  lines.push(
    '',
    `_Totals: cache-read ${formatTokenCount(summary?.cacheReadTokens)} · cache-write ${formatTokenCount(summary?.cacheWriteTokens)} · reasoning ${formatTokenCount(summary?.reasoningTokens)} · peak observed context ${formatTokenCount(summary?.maxContextTokens)} / ${summary?.maxContextMessages ?? 0} messages._`,
    '',
    '_AI credits are derived from Copilot nano-AIU usage (nano-AIU ÷ 1e9). Credit checkpoints can lag live token growth; GitHub billing remains the source of truth. Cache token fields depend on what the active Copilot runtime/model reports._',
  );
  return lines.join('\n');
}

function diagnosticsMarkdown(snapshots = []) {
  const lines = ['**Convergent diagnostics**', ''];
  if (!snapshots.length) return `${lines.join('\n')}No agent diagnostics are available.`;
  for (const snapshot of snapshots) {
    const current = snapshot.currentTool
      ? `${snapshot.currentTool.name}${snapshot.currentTool.detail ? ` — ${snapshot.currentTool.detail}` : ''} (${formatDuration(snapshot.currentTool.elapsedMs)}, quiet ${formatDuration(snapshot.currentTool.quietMs)})`
      : 'none';
    lines.push(`- **${snapshot.agent}**: current tool ${current}; last activity ${formatDuration(snapshot.lastActivityAgoMs)} ago; stalls ${snapshot.stalls?.length ?? 0}`);
    for (const tool of (snapshot.tools ?? []).slice(0, 5)) {
      lines.push(`  - ${tool.name}: ${tool.calls} call(s), max ${formatDuration(tool.maxMs)}, failures ${tool.failures}`);
    }
  }
  return lines.join('\n');
}

class VscodeWorkflowUi {
  constructor(vscode, stream, output) {
    this.vscode = vscode;
    this.stream = stream;
    this.output = output;
    this.lastUsageLogAt = 0;
    this.lastUsageChatAt = 0;
    this.lastLongToolChatStatusAt = new Map();
    this.agentInactivityTimeoutMs = undefined;
    this.toolStallTimeoutMs = undefined;
    this.stallGraceMs = undefined;
    this.heartbeatMs = undefined;
  }

  audit(event) {
    try { void this.auditEvent?.(event); } catch {}
  }

  log(message) {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  phase(name, detail) {
    this.stream.progress(`${name}: ${detail}`);
    this.log(`${name}: ${detail}`);
    this.audit({ type: 'phase', name, detail });
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
    this.audit({ type: 'plan_accepted', plan, routes });
  }

  taskStarted(task, index, total, routing, policy) {
    this.stream.markdown(`\n### Task ${index}/${total}: ${task.title}\n`);
    this.stream.markdown(`**Route:** \`${routing.route}\` · **risk:** \`${routing.risk}\` — ${policy.description}\n`);
    if (routing.reason) this.stream.markdown(`_${routing.reason}_\n`);
    this.stream.progress(`${task.title}: ${routing.route} workflow starting`);
    this.log(`Task ${task.id} started: ${task.title}; route=${routing.route}; risk=${routing.risk}; reason=${routing.reason}`);
    this.audit({ type: 'task_start', task, index, total, routing, policy });
  }

  agentConfiguration(entries) {
    const text = entries
      .filter(Boolean)
      .map((entry) => `${entry.role}: ${entry.model}${entry.effort ? ` (${entry.effort} effort)` : ''}`)
      .join(' · ');
    if (text) {
      this.stream.progress(text);
      this.log(`Agent configuration: ${text}`);
      this.audit({ type: 'agent_configuration', entries });
    }
  }

  agentTools(agent, tools) {
    this.log(`${agent} available tools: ${(tools ?? []).join(', ')}`);
    this.audit({ type: 'agent_tools', agent, tools });
  }

  readOnlyResult(task) {
    this.stream.markdown(`\n${task.result}\n`);
    this.log(`Read-only task ${task.id} answered by coordinator.`);
    this.audit({ type: 'read_only_result', taskId: task.id, result: task.result });
  }

  taskCompleted(task, route) {
    const detail = route === 'read_only'
      ? 'completed by coordinator inspection'
      : route === 'trivial'
        ? 'passed lightweight implementer + peer review'
        : 'passed A/B convergence and strong review';
    this.stream.markdown(`✓ **${task.title}** ${detail}.\n`);
    this.log(`Task ${task.id} completed via ${route}.`);
    this.audit({ type: 'task_complete', taskId: task.id, title: task.title, route });
  }

  taskCommitted(task, sha) {
    this.stream.markdown(`  ↳ checkpoint commit \`${String(sha).slice(0, 12)}\` for **${task.id}**\n`);
    this.log(`Task ${task.id} checkpoint committed at ${sha}.`);
    this.audit({ type: 'task_commit', taskId: task.id, sha });
  }

  taskCommitSkipped(task, reason) {
    this.log(`Task ${task.id} checkpoint commit skipped: ${reason}`);
    this.audit({ type: 'task_commit_skipped', taskId: task.id, reason });
  }

  passResult(worker, report, changed, revision, meta = {}) {
    const mark = report.verdict === 'clean' ? '✓' : report.verdict === 'blocked' ? '⛔' : '↻';
    const state = changed ? 'changed workspace' : report.verdict;
    const duration = meta.durationMs !== undefined ? ` · ${formatDuration(meta.durationMs)}` : '';
    this.stream.markdown(`${mark} Worker ${worker}: **${state}**${duration} — ${report.summary}\n`);
    this.log(`Worker ${worker}: ${report.verdict}, changed=${changed}, revision=${revision.slice(0, 12)}, duration=${meta.durationMs ?? 0}ms; ${report.summary}`);
    this.audit({ type: 'worker_pass_result', worker, report, changed, workspaceFingerprint: revision, durationMs: meta.durationMs, usage: meta.usage });
    if (meta.usage) this.usageProgress(meta.usage);
  }

  converged(revision, pass) {
    this.stream.markdown(`✓ Workers A and B both approved workspace fingerprint \`${revision.slice(0, 12)}\` after ${pass} review/fix pass(es).\n`);
    this.log(`Workers converged on workspace fingerprint ${revision} after ${pass} pass(es).`);
    this.audit({ type: 'workers_converged', workspaceFingerprint: revision, passes: pass });
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
    this.audit({ type: 'strong_review_result', cycle, review, durationMs: meta.durationMs, usage: meta.usage });
    if (meta.usage) this.usageProgress(meta.usage);
  }

  escalated(from, to, reason) {
    this.stream.markdown(`↗ **Workflow escalated:** \`${from}\` → \`${to}\` — ${reason}\n`);
    this.stream.progress(`Escalated to ${to}: ${reason}`);
    this.log(`Workflow escalated ${from} -> ${to}: ${reason}`);
    this.audit({ type: 'workflow_escalated', from, to, reason });
  }

  usageProgress(summary) {
    this.stream.progress(`Usage: ${compactUsage(summary)}`);
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
    const text = compactActivity(intent);
    if (text) this.stream.progress(`${agent}: ${text}`);
    this.log(`${agent} intent: ${intent ?? ''}`);
  }

  agentTool(agent, tool, detail = '') {
    const text = `${agent} tool: ${tool}${detail ? ` — ${compactActivity(detail, 300)}` : ''}`;
    this.stream.progress(text);
    this.log(text);
  }

  agentToolComplete(agent, tool, durationMs, success) {
    const text = `${agent} tool complete: ${tool} · ${formatDuration(durationMs)} · ${success ? 'success' : 'failure'}`;
    if (!success || durationMs >= 10_000) this.stream.progress(text);
    this.log(text);
  }

  agentHeartbeat(agent, snapshot) {
    const tool = snapshot?.currentTool;
    const detail = tool
      ? `${tool.name}${tool.detail ? ` — ${tool.detail}` : ''} running ${formatDuration(tool.elapsedMs)} · no progress ${formatDuration(tool.quietMs)}`
      : `working · last activity ${formatDuration(snapshot?.lastActivityAgoMs ?? 0)} ago`;

    this.log(`${agent} heartbeat: ${detail}`);

    if (!tool || tool.elapsedMs < 60_000) return;
    const now = Date.now();
    const last = this.lastLongToolChatStatusAt.get(agent) ?? 0;
    if (now - last < 120_000) return;
    this.lastLongToolChatStatusAt.set(agent, now);
    this.stream.progress(`${agent}: ${tool.name}${tool.detail ? ` — ${tool.detail}` : ''} still running · ${formatDuration(tool.elapsedMs)} elapsed · ${formatDuration(tool.quietMs)} since progress`);
  }

  agentToolStallWarning(agent, tool, quietMs, timeoutMs, diagnostic = null) {
    const current = diagnostic?.currentTool;
    const command = current?.detail ? ` — ${current.detail}` : '';
    const detail = `${tool}${command} has produced no progress for ${formatDuration(quietMs)} (soft watchdog ${formatDuration(timeoutMs)}). Waiting for your decision.`;
    this.stream.markdown(`\n⚠ **${agent}: possible stalled tool** — ${detail}\n`);
    this.log(`${agent} STALL WARNING: ${detail}`);
  }

  async agentToolStallDecision(agent, snapshot) {
    const tool = snapshot?.currentTool;
    if (!tool) return { action: 'continue', waitMs: 5 * 60_000 };
    const command = tool.detail ? `\n\n${tool.detail}` : '';
    const choice = await this.vscode.window.showWarningMessage(
      `${agent}: ${tool.name} has produced no progress for ${formatDuration(tool.quietMs)} after ${formatDuration(tool.elapsedMs)} total.${command}\n\nThe built-in Copilot tool cannot currently be killed independently; aborting stops this agent turn.`,
      { modal: true },
      'Continue 5 min',
      'Continue 15 min',
      'Abort agent turn',
    );
    if (choice === 'Abort agent turn') return { action: 'abort' };
    if (choice === 'Continue 15 min') return { action: 'continue', waitMs: 15 * 60_000 };
    return { action: 'continue', waitMs: 5 * 60_000 };
  }

  agentToolWaitExtended(agent, tool, waitMs) {
    const detail = `${tool} will continue running; Convergent will not ask again for ${formatDuration(waitMs)} unless the tool completes first.`;
    this.stream.progress(`${agent}: ${detail}`);
    this.log(`${agent}: ${detail}`);
  }

  agentToolStalled(agent, tool, elapsedMs, diagnostic) {
    const detail = `${tool} was aborted by user/watchdog decision after ${formatDuration(elapsedMs)} total; cancelling this agent turn.`;
    this.stream.markdown(`\n⚠ **${agent} stalled:** ${detail}\n`);
    this.log(`${agent} STALLED: ${detail}`);
    this.log(`${agent} stall diagnostic: ${JSON.stringify(diagnostic)}`);
  }

  agentInactivityWarning(agent, inactiveMs, timeoutMs) {
    const detail = `no agent/tool activity for ${formatDuration(inactiveMs)} (soft inactivity watchdog ${formatDuration(timeoutMs)}). Waiting for your decision.`;
    this.stream.markdown(`\n⚠ **${agent}: no activity** — ${detail}\n`);
    this.log(`${agent} INACTIVITY WARNING: ${detail}`);
  }

  async agentInactivityDecision(agent, snapshot) {
    const choice = await this.vscode.window.showWarningMessage(
      `${agent} has produced no agent or tool activity for ${formatDuration(snapshot?.lastActivityAgoMs ?? 0)}. Continue waiting or abort this agent turn?`,
      { modal: true },
      'Continue 5 min',
      'Abort agent turn',
    );
    if (choice === 'Abort agent turn') return { action: 'abort' };
    return { action: 'continue', waitMs: 5 * 60_000 };
  }

  agentInactivityWaitExtended(agent, waitMs) {
    const detail = `continuing to wait for ${agent}; next inactivity decision is deferred by ${formatDuration(waitMs)}.`;
    this.stream.progress(detail);
    this.log(detail);
  }

  agentInactivityStalled(agent, inactiveMs, diagnostic) {
    const detail = `no agent/tool activity resumed (${formatDuration(inactiveMs)} quiet); cancelling this agent turn.`;
    this.stream.markdown(`\n⚠ **${agent} inactive:** ${detail}\n`);
    this.log(`${agent} INACTIVE: ${detail}`);
    this.log(`${agent} inactivity diagnostic: ${JSON.stringify(diagnostic)}`);
  }

  async limitDecision(kind, details = {}) {
    const current = Number(details.current) || 0;
    const limit = Number(details.limit) || 0;
    let message;
    let choices;

    if (kind === 'ai_credits') {
      const increment = Math.max(1, Number(details.increment) || limit || 100);
      message = `Convergent has reached the configured soft AI-credit budget (${limit.toFixed(3)}); reported usage is ≈${current.toFixed(3)} AI credits. The current agent turn has finished at a safe boundary.`;
      choices = [`Continue +${increment} credits`, 'Continue without budget', 'Pause & resume later'];
      const choice = await this.vscode.window.showWarningMessage(message, { modal: true }, ...choices);
      this.log(`AI-credit limit decision: ${choice ?? 'dismissed'}; usage=${current}; ceiling=${limit}`);
      this.audit({ type: 'limit_decision', kind, current, limit, choice });
      if (choice === 'Continue without budget') return { action: 'unlimited' };
      if (choice === choices[0]) return { action: 'continue', additional: increment };
      return { action: 'pause' };
    }

    const noun = kind === 'worker_passes' ? 'A/B review/fix passes' : 'strong-review cycles';
    message = `Convergent reached the configured soft limit of ${limit} ${noun}. The workflow is at a safe decision boundary rather than failed.`;
    choices = ['Continue 1 more', 'Continue 3 more', 'Pause & resume later'];
    const choice = await this.vscode.window.showWarningMessage(message, { modal: true }, ...choices);
    this.log(`${kind} limit decision: ${choice ?? 'dismissed'}; current=${current}; limit=${limit}`);
    this.audit({ type: 'limit_decision', kind, current, limit, choice });
    if (choice === choices[0]) return { action: 'continue', additional: 1 };
    if (choice === choices[1]) return { action: 'continue', additional: 3 };
    return { action: 'pause' };
  }

  workflowPaused(reason) {
    this.stream.markdown(`\n⏸ **Convergent paused at a safe boundary.** ${reason}\n\nUse \`@convergent /resume\` when you want to continue.\n`);
    this.log(`Workflow paused: ${reason}`);
    this.audit({ type: 'workflow_paused', reason });
  }

  agentControlTimeout(agent, operation, timeoutMs) {
    this.log(`${agent} CONTROL TIMEOUT: ${operation} did not settle within ${formatDuration(timeoutMs)}; Convergent detached instead of blocking the UI.`);
  }

  agentMessage(agent, content) {
    const text = compactActivity(content);
    if (text) {
      this.stream.progress(`${agent}: ${text}`);
      this.log(`${agent}: ${content}`);
    }
  }

  agentUsageEvent(agent, summary) {
    const now = Date.now();
    if (now - this.lastUsageLogAt > 1500) {
      this.log(`${agent} usage checkpoint: ${compactUsage(summary)}`);
      this.lastUsageLogAt = now;
    }
    if (now - this.lastUsageChatAt > 30_000) {
      this.stream.progress(`Usage so far: ${compactUsage(summary)}`);
      this.lastUsageChatAt = now;
    }
  }

  agentError(agent, message) {
    this.stream.progress(`${agent} error: ${compactActivity(message, 300)}`);
    this.log(`${agent} ERROR: ${message}`);
    this.audit({ type: 'agent_error', agent, message });
  }
}

module.exports = {
  VscodeWorkflowUi,
  formatDuration,
  formatTokenCount,
  compactUsage,
  detailedUsageMarkdown,
  diagnosticsMarkdown,
};
