'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const SENSITIVE_TEXT_KEYS = /^(content|prompt|request|result|output|text|message|intent|arguments|toolArgs|input|systemPrompt|guidance|operatorAnswer|answer|stack|partialResult|partial_result|stdout|stderr|response|review|report|findings|checks|plan|task)$/i;

function safeName(value) {
  return String(value ?? 'run').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'run';
}

function textInfo(value) {
  const text = String(value ?? '');
  return { chars: text.length, bytes: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function compactValue(value, level, maxFullBytes, sensitive = false) {
  if (typeof value === 'string') {
    if (!sensitive) return value.length <= 500 ? value : `${value.slice(0, 499)}…`;
    if (level === 'full' && Buffer.byteLength(value) <= maxFullBytes) return value;
    return { kind: 'text', ...textInfo(value), truncated: level === 'full' && Buffer.byteLength(value) > maxFullBytes };
  }
  if (Array.isArray(value)) return value.map((item) => compactValue(item, level, maxFullBytes, sensitive));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const childSensitive = sensitive || SENSITIVE_TEXT_KEYS.test(key);
    if (childSensitive && item && typeof item === 'object' && !Array.isArray(item) && level !== 'full') {
      let encoded = '';
      try { encoded = JSON.stringify(item); } catch { encoded = String(item); }
      result[key] = { kind: 'structured', ...textInfo(encoded) };
    } else {
      result[key] = compactValue(item, level, maxFullBytes, childSensitive);
    }
  }
  return result;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function shortText(value, max = 180) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatCount(value) {
  const n = numberOrZero(value);
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

function toolArgs(data = {}) {
  return data.arguments ?? data.toolArgs ?? data.args ?? data.input ?? data.parameters ?? {};
}

function toolDetail(data = {}) {
  let args = toolArgs(data);
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return shortText(args); }
  }
  if (!args || typeof args !== 'object') return '';
  for (const key of ['fullCommandText', 'command', 'script', 'query', 'pattern', 'path', 'filePath', 'file', 'target', 'uri']) {
    if (args[key]) return shortText(args[key]);
  }
  return '';
}

function stableToolSignature(event = {}) {
  const tool = String(event.tool ?? event.data?.toolName ?? 'unknown');
  let encoded;
  try { encoded = JSON.stringify(toolArgs(event.data ?? {})); } catch { encoded = String(toolArgs(event.data ?? {})); }
  const hash = crypto.createHash('sha256').update(encoded ?? '').digest('hex').slice(0, 16);
  return { key: `${event.agent ?? '?'}\0${tool}\0${hash}`, tool, argsHash: hash, detail: toolDetail(event.data ?? {}) };
}

function findingIdentity(finding = {}) {
  const canonical = [finding.file ?? '', finding.severity ?? '', finding.title ?? '', finding.description ?? ''].join('\0');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 20);
}

function trajectoryMarkdown(summary) {
  const trajectory = summary.trajectory ?? {};
  const lines = [
    '# Convergent trajectory analysis',
    '',
    `Status: **${summary.status ?? 'unknown'}**  `,
    `Audit level: **${summary.level ?? 'metadata'}**  `,
    `Duration: **${Math.round(numberOrZero(summary.durationMs) / 1000)}s**`,
    '',
    '## Agent cost/context',
    '',
    '| Agent | Model | LLM calls | Input | Output | Cache read | Cache write | Reasoning | Peak context | Prompts | Tools |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const [agent, entry] of Object.entries(trajectory.agents ?? {})) {
    lines.push(`| ${agent} | ${entry.model ?? 'n/a'} | ${entry.llmCalls ?? 0} | ${formatCount(entry.inputTokens)} | ${formatCount(entry.outputTokens)} | ${formatCount(entry.cacheReadTokens)} | ${formatCount(entry.cacheWriteTokens)} | ${formatCount(entry.reasoningTokens)} | ${formatCount(entry.peakContextTokens)} / ${entry.peakContextMessages ?? 0} msg | ${entry.promptSends ?? 0} | ${entry.toolCalls ?? 0} |`);
  }

  lines.push('', '## Repeated tool signatures', '');
  if (!(trajectory.repeatedToolCalls ?? []).length) lines.push('No identical tool argument signature was repeated.');
  else {
    for (const item of trajectory.repeatedToolCalls) {
      const detail = item.detail ? ` — ${item.detail}` : '';
      lines.push(`- ${item.agent}: \`${item.tool}\` ×${item.count} (args ${item.argsHash})${detail}`);
    }
  }

  lines.push('', '## Strong-review finding timeline', '');
  if (!(trajectory.reviewTimeline ?? []).length) lines.push('No strong-review result was recorded.');
  else {
    for (const item of trajectory.reviewTimeline) {
      lines.push(`- Cycle ${item.cycle}: ${item.verdict}; ${item.findingCount} finding(s), ${item.newFindingCount} first-seen in this cycle.`);
      for (const finding of item.firstSeen ?? []) {
        const text = finding.title ? ` ${finding.title}${finding.file ? ` (${finding.file})` : ''}` : ` id=${finding.id}`;
        lines.push(`  - ${finding.severity ?? 'unknown'}:${text}`);
      }
    }
    lines.push('', `Late-finding cycles (cycle > 1 with at least one first-seen finding): **${trajectory.lateFindingCycles ?? 0}**.`);
  }

  lines.push('', '## Worker pass timeline', '');
  if (!(trajectory.workerPassTimeline ?? []).length) lines.push('No worker pass was recorded.');
  else {
    for (const pass of trajectory.workerPassTimeline) {
      lines.push(`- Worker ${pass.worker}: ${pass.verdict}; changed=${pass.changed}; ${Math.round(numberOrZero(pass.durationMs) / 1000)}s; fingerprint ${String(pass.workspaceFingerprint ?? '').slice(0, 12) || 'n/a'}.`);
    }
  }

  lines.push(
    '',
    '## Interpretation notes',
    '',
    '- Repeated tool signatures are optimization candidates, not proof of waste; a repeated read/test can be justified after intervening changes.',
    '- A finding first seen in a later review cycle is not proof that it existed before remediation. Full audit mode provides the intervening tool/edit trajectory needed to investigate that.',
    '- `promptSends` measures prompts explicitly sent by Convergent. `inputTokens`/cache/context events come from the Copilot runtime and therefore also reflect accumulated agent/tool history and provider-side context that Convergent does not reconstruct byte-for-byte.',
    '- Metadata audit deliberately omits source-bearing prompt/message/tool/finding details. Use `convergent.audit.level = full` for a diagnostic run when you want deep content-level auditing.',
    '',
  );
  return lines.join('\n');
}

async function directorySize(directory) {
  let total = 0;
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(file);
    else { try { total += (await fs.stat(file)).size; } catch {} }
  }
  return total;
}

class TrajectoryAudit {
  constructor({ rootDir, enabled = true, level = 'metadata', maxRuns = 10, maxSizeMB = 250, maxAgeDays = 14, maxFullEventKB = 512 } = {}) {
    this.rootDir = rootDir;
    this.enabled = Boolean(enabled && rootDir);
    this.level = level === 'full' ? 'full' : 'metadata';
    this.maxRuns = Math.max(1, Math.floor(Number(maxRuns) || 10));
    this.maxSizeBytes = Math.max(1, Number(maxSizeMB) || 250) * 1024 * 1024;
    this.maxAgeMs = Math.max(1, Number(maxAgeDays) || 14) * 24 * 60 * 60 * 1000;
    this.maxFullBytes = Math.max(16, Number(maxFullEventKB) || 512) * 1024;
    this.runDir = null;
    this.eventsPath = null;
    this.queue = Promise.resolve();
    this.counts = new Map();
    this.agents = new Map();
    this.toolSignatures = new Map();
    this.reviewFindingKeys = new Set();
    this.reviewTimeline = [];
    this.workerPassTimeline = [];
    this.startedAt = Date.now();
  }

  agent(name = 'unknown') {
    const key = String(name || 'unknown');
    const entry = this.agents.get(key) ?? { sessions: 0, model: undefined, reasoningEffort: undefined, systemPromptChars: 0, systemPromptBytes: 0, promptSends: 0, promptChars: 0, promptBytes: 0, assistantMessages: 0, assistantMessageChars: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakContextTokens: 0, peakContextMessages: 0, toolCalls: 0, tools: {} };
    this.agents.set(key, entry);
    return entry;
  }

  observe(event = {}) {
    const type = String(event.type ?? 'event');
    const entry = event.agent ? this.agent(event.agent) : null;
    if (type === 'session_create' && entry) {
      entry.sessions += 1; entry.model = event.modelName ?? event.model ?? entry.model; entry.reasoningEffort = event.reasoningEffort ?? entry.reasoningEffort;
      const info = textInfo(event.systemPrompt ?? ''); entry.systemPromptChars += info.chars; entry.systemPromptBytes += info.bytes;
    } else if (type === 'prompt_send' && entry) {
      const info = textInfo(event.prompt ?? ''); entry.promptSends += 1; entry.promptChars += info.chars; entry.promptBytes += info.bytes;
    } else if (type === 'assistant_message' && entry) {
      entry.assistantMessages += 1; entry.assistantMessageChars += String(event.content ?? '').length;
    } else if (type === 'assistant_usage' && entry) {
      const data = event.data ?? {}; entry.llmCalls += 1; entry.inputTokens += numberOrZero(data.inputTokens); entry.outputTokens += numberOrZero(data.outputTokens); entry.reasoningTokens += numberOrZero(data.reasoningTokens); entry.cacheReadTokens += numberOrZero(data.cacheReadTokens); entry.cacheWriteTokens += numberOrZero(data.cacheWriteTokens);
    } else if (type === 'context_usage' && entry) {
      const data = event.data ?? {}; entry.peakContextTokens = Math.max(entry.peakContextTokens, numberOrZero(data.currentTokens)); entry.peakContextMessages = Math.max(entry.peakContextMessages, numberOrZero(data.messagesLength ?? data.messageCount));
    } else if (type === 'tool_start' && entry) {
      const signature = stableToolSignature(event); entry.toolCalls += 1; entry.tools[signature.tool] = (entry.tools[signature.tool] ?? 0) + 1;
      const previous = this.toolSignatures.get(signature.key) ?? { agent: event.agent, ...signature, count: 0 }; previous.count += 1; this.toolSignatures.set(signature.key, previous);
    } else if (type === 'strong_review_result') {
      const findings = Array.isArray(event.review?.findings) ? event.review.findings : []; const firstSeen = [];
      for (const finding of findings) {
        const id = findingIdentity(finding);
        if (!this.reviewFindingKeys.has(id)) firstSeen.push(this.level === 'full' ? { id, severity: finding.severity, title: finding.title, file: finding.file } : { id, severity: finding.severity });
        this.reviewFindingKeys.add(id);
      }
      this.reviewTimeline.push({ cycle: event.cycle, verdict: event.review?.verdict, findingCount: findings.length, newFindingCount: firstSeen.length, firstSeen });
    } else if (type === 'worker_pass_result') {
      this.workerPassTimeline.push({ worker: event.worker, verdict: event.report?.verdict, changed: Boolean(event.changed), workspaceFingerprint: event.workspaceFingerprint, durationMs: event.durationMs });
    }
  }

  trajectorySummary() {
    const agents = {}; for (const [name, entry] of this.agents.entries()) agents[name] = { ...entry };
    const repeatedToolCalls = [...this.toolSignatures.values()].filter((item) => item.count > 1).sort((a, b) => b.count - a.count).slice(0, 30).map(({ key, detail, ...item }) => this.level === 'full' ? { ...item, detail } : item);
    return { agents, repeatedToolCalls, repeatedToolSignatureCount: repeatedToolCalls.length, workerPassTimeline: this.workerPassTimeline, reviewTimeline: this.reviewTimeline, lateFindingCycles: this.reviewTimeline.filter((item) => Number(item.cycle) > 1 && item.newFindingCount > 0).length };
  }

  async start(meta = {}) {
    if (!this.enabled) return null;
    const runId = safeName(meta.runId ?? `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(this.rootDir, { recursive: true }); await this.rotate();
    this.runDir = path.join(this.rootDir, runId); this.eventsPath = path.join(this.runDir, 'events.jsonl'); await fs.mkdir(this.runDir, { recursive: true });
    const manifestMeta = compactValue(meta, this.level, this.maxFullBytes);
    await fs.writeFile(path.join(this.runDir, 'manifest.json'), `${JSON.stringify({ version: 1, runId, startedAt: new Date(this.startedAt).toISOString(), level: this.level, ...manifestMeta }, null, 2)}\n`, 'utf8');
    await this.record({ type: 'run_start', ...meta }); return this.runDir;
  }

  record(event = {}) {
    if (!this.enabled || !this.eventsPath) return Promise.resolve();
    const type = String(event.type ?? 'event'); this.counts.set(type, (this.counts.get(type) ?? 0) + 1); this.observe(event);
    const line = `${JSON.stringify(compactValue({ at: new Date().toISOString(), ...event }, this.level, this.maxFullBytes))}\n`;
    this.queue = this.queue.then(() => fs.appendFile(this.eventsPath, line, 'utf8')).catch(() => {}); return this.queue;
  }

  async finish({ status = 'complete', usage = null, stats = null, error = null } = {}) {
    if (!this.enabled || !this.runDir) return null;
    await this.record({ type: 'run_end', status, usage, stats, error }); await this.queue;
    const summary = { status, startedAt: new Date(this.startedAt).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - this.startedAt, level: this.level, eventCounts: Object.fromEntries([...this.counts.entries()].sort(([a], [b]) => a.localeCompare(b))), trajectory: this.trajectorySummary(), usage, stats, error };
    await fs.writeFile(path.join(this.runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await fs.writeFile(path.join(this.runDir, 'analysis.md'), `${trajectoryMarkdown(summary)}\n`, 'utf8');
    await this.rotate(); return this.runDir;
  }

  async rotate() {
    if (!this.enabled) return;
    let entries; try { entries = await fs.readdir(this.rootDir, { withFileTypes: true }); } catch { return; }
    const now = Date.now(); const dirs = [];
    for (const entry of entries) { if (!entry.isDirectory()) continue; const directory = path.join(this.rootDir, entry.name); try { const stat = await fs.stat(directory); dirs.push({ directory, mtimeMs: stat.mtimeMs, size: await directorySize(directory) }); } catch {} }
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs); let total = dirs.reduce((sum, item) => sum + item.size, 0);
    for (let index = 0; index < dirs.length; index += 1) {
      const item = dirs[index]; const overCount = index >= this.maxRuns; const tooOld = now - item.mtimeMs > this.maxAgeMs; const overSize = total > this.maxSizeBytes && item.directory !== this.runDir;
      if (!overCount && !tooOld && !overSize) continue; if (item.directory === this.runDir) continue;
      try { await fs.rm(item.directory, { recursive: true, force: true }); total -= item.size; } catch {}
    }
  }
}

module.exports = { TrajectoryAudit, textInfo, compactValue, safeName, directorySize, stableToolSignature, toolDetail, findingIdentity, trajectoryMarkdown };
