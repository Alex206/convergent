'use strict';

function oneLine(value, max = 500) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

class HeadlessWorkflowUi {
  constructor({ eventSink, logger = console, limitPolicy = 'pause' } = {}) {
    this.eventSink = eventSink;
    this.auditEvent = eventSink;
    this.logger = logger;
    this.limitPolicy = limitPolicy === 'continue' ? 'continue' : 'pause';
    this.flowMode = 'auto';
    this.agentInactivityTimeoutMs = undefined;
    this.toolStallTimeoutMs = undefined;
    this.stallGraceMs = undefined;
    this.heartbeatMs = undefined;
  }

  emit(event) { try { void this.eventSink?.(event); } catch {} }
  audit(event) { this.emit(event); }
  log(message) { this.logger?.log?.(`[${new Date().toISOString()}] ${message}`); }
  runStarted(data) {
    this.flowMode = data?.flowMode ?? 'auto';
    this.log(`Convergent ${data?.version ?? 'unknown'} headless run started; flow=${this.flowMode}`);
    this.emit({ type: 'ui_run_started', ...data });
  }
  phase(name, detail) { this.log(`${name}: ${detail}`); this.audit({ type: 'phase', name, detail }); }
  plan(plan, routes = []) {
    const taskCount = plan?.tasks?.length ?? 0;
    this.log(`Plan accepted with ${taskCount} task(s).`);
    this.audit({ type: 'plan_accepted', plan, routes });
    if (this.flowMode === 'fast' && taskCount > 3) {
      const message = `Fast headless plan has ${taskCount} tasks; maximum is 3 before implementation. Stop here and consolidate the request at acceptance boundaries before spending worker/reviewer quota.`;
      this.log(message);
      this.audit({ type: 'headless_plan_budget_exceeded', taskCount, limit: 3, message });
      const error = new Error(message);
      error.code = 'CONVERGENT_HEADLESS_PLAN_BUDGET';
      error.plan = plan;
      error.routes = routes;
      throw error;
    }
  }
  taskStarted(task, index, total, routing, policy) { this.log(`Task ${index}/${total} ${task.id}: ${task.title}; route=${routing.route}; risk=${routing.risk}`); this.audit({ type: 'task_start', task, index, total, routing, policy }); }
  agentConfiguration(entries) { this.log(`Agent configuration: ${(entries ?? []).map((e) => `${e.role}=${e.model}${e.effort ? `/${e.effort}` : ''}`).join(', ')}`); this.audit({ type: 'agent_configuration', entries }); }
  agentTools(agent, tools) { this.log(`${agent} tools: ${(tools ?? []).join(', ')}`); this.audit({ type: 'agent_tools', agent, tools }); }
  readOnlyResult(task) { this.log(`Read-only result ${task.id}: ${oneLine(task.result)}`); this.audit({ type: 'read_only_result', taskId: task.id, result: task.result }); }
  taskCompleted(task, route) { this.log(`Task ${task.id} completed via ${route}.`); this.audit({ type: 'task_complete', taskId: task.id, title: task.title, route }); }
  taskCommitted(task, sha) { this.log(`Task ${task.id} checkpoint commit ${sha}.`); this.audit({ type: 'task_commit', taskId: task.id, sha }); }
  taskCommitSkipped(task, reason) { this.log(`Task ${task.id} commit skipped: ${reason}`); this.audit({ type: 'task_commit_skipped', taskId: task.id, reason }); }
  passResult(worker, report, changed, revision, meta = {}) { this.log(`Worker ${worker}: ${report.verdict}; changed=${changed}; revision=${String(revision).slice(0, 12)}; ${oneLine(report.summary)}`); this.audit({ type: 'worker_pass_result', worker, report, changed, workspaceFingerprint: revision, durationMs: meta.durationMs, usage: meta.usage }); }
  converged(revision, pass) { this.log(`Workers converged on ${String(revision).slice(0, 12)} after ${pass} pass(es).`); this.audit({ type: 'workers_converged', workspaceFingerprint: revision, passes: pass }); }
  reviewResult(review, cycle, meta = {}) { this.log(`Strong reviewer cycle ${cycle}: ${review.verdict}; ${oneLine(review.summary)}`); this.audit({ type: 'strong_review_result', cycle, review, durationMs: meta.durationMs, usage: meta.usage }); }
  escalated(from, to, reason) { this.log(`Escalated ${from} -> ${to}: ${reason}`); this.audit({ type: 'workflow_escalated', from, to, reason }); }
  usageProgress(summary) { this.audit({ type: 'headless_usage_progress', usage: summary }); }
  runSummary(summary, stats = {}) { this.log(`Run summary: ${JSON.stringify({ aiCredits: summary?.aiCredits, turns: summary?.turns, calls: summary?.calls, stats })}`); }
  agentIntent(agent, intent) { this.log(`${agent} intent: ${oneLine(intent)}`); }
  agentTool(agent, tool, detail = '') { this.log(`${agent} tool: ${tool}${detail ? ` — ${oneLine(detail, 300)}` : ''}`); }
  agentToolComplete(agent, tool, durationMs, success) { this.log(`${agent} tool complete: ${tool}; ${durationMs}ms; success=${success}`); }
  agentHeartbeat(agent, snapshot) { this.emit({ type: 'headless_heartbeat', agent, snapshot }); }
  agentToolStallWarning(agent, tool, quietMs, timeoutMs, diagnostic) { this.log(`${agent} possible stalled tool ${tool}; quiet=${quietMs}ms; timeout=${timeoutMs}ms`); this.audit({ type: 'headless_tool_stall_warning', agent, tool, quietMs, timeoutMs, diagnostic }); }
  async agentToolStallDecision() { return { action: 'abort' }; }
  agentToolWaitExtended(agent, tool, waitMs) { this.log(`${agent} tool ${tool} wait extended ${waitMs}ms.`); }
  agentToolStalled(agent, tool, elapsedMs, diagnostic) { this.log(`${agent} stalled tool ${tool} after ${elapsedMs}ms.`); this.audit({ type: 'headless_tool_stalled', agent, tool, elapsedMs, diagnostic }); }
  agentInactivityWarning(agent, inactiveMs, timeoutMs) { this.log(`${agent} inactive for ${inactiveMs}ms; timeout=${timeoutMs}ms.`); }
  async agentInactivityDecision() { return { action: 'abort' }; }
  agentInactivityWaitExtended(agent, waitMs) { this.log(`${agent} inactivity wait extended ${waitMs}ms.`); }
  agentInactivityStalled(agent, inactiveMs, diagnostic) { this.log(`${agent} inactivity stalled after ${inactiveMs}ms.`); this.audit({ type: 'headless_inactivity_stalled', agent, inactiveMs, diagnostic }); }
  async limitDecision(kind, details = {}) { const decision = this.limitPolicy === 'continue' ? { action: 'continue', additional: kind === 'ai_credits' ? Math.max(1, Number(details.increment) || 100) : 1 } : { action: 'pause' }; this.audit({ type: 'limit_decision', kind, ...details, choice: decision.action, headless: true }); return decision; }
  workflowPaused(reason) { this.log(`Workflow paused: ${reason}`); this.audit({ type: 'workflow_paused', reason }); }
  agentControlTimeout(agent, operation, timeoutMs) { this.log(`${agent} control timeout: ${operation}; ${timeoutMs}ms.`); }
  agentMessage(agent, content) { const text = oneLine(content); if (text) this.log(`${agent}: ${text}`); }
  agentUsageEvent(agent, summary) { this.emit({ type: 'headless_usage_event', agent, usage: summary }); }
  agentError(agent, message) { this.log(`${agent} ERROR: ${message}`); this.audit({ type: 'agent_error', agent, message }); }
  agentReportRecovered(agent, toolName) { this.log(`${agent}: recovered serialized ${toolName} report.`); this.audit({ type: 'agent_report_recovered', agent, toolName }); }
}

module.exports = { HeadlessWorkflowUi, oneLine };
