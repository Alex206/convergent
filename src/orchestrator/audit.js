'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function safeName(value) {
  return String(value ?? 'run')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'run';
}

function textInfo(value) {
  const text = String(value ?? '');
  return {
    chars: text.length,
    bytes: Buffer.byteLength(text),
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
  };
}

function compactValue(value, level, maxFullBytes) {
  if (typeof value === 'string') {
    if (level === 'full' && Buffer.byteLength(value) <= maxFullBytes) return value;
    return { kind: 'text', ...textInfo(value), truncated: level === 'full' && Buffer.byteLength(value) > maxFullBytes };
  }
  if (Array.isArray(value)) return value.map((item) => compactValue(item, level, maxFullBytes));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(content|prompt|result|output|text|message|intent|arguments|toolArgs|input)$/i.test(key)) {
      if (typeof item === 'string') result[key] = compactValue(item, level, maxFullBytes);
      else if (level === 'full') result[key] = compactValue(item, level, maxFullBytes);
      else {
        let encoded = '';
        try { encoded = JSON.stringify(item); } catch { encoded = String(item); }
        result[key] = { kind: 'structured', ...textInfo(encoded) };
      }
    } else {
      result[key] = compactValue(item, level, maxFullBytes);
    }
  }
  return result;
}

async function directorySize(directory) {
  let total = 0;
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(file);
    else {
      try { total += (await fs.stat(file)).size; } catch {}
    }
  }
  return total;
}

class TrajectoryAudit {
  constructor({
    rootDir,
    enabled = true,
    level = 'metadata',
    maxRuns = 10,
    maxSizeMB = 250,
    maxAgeDays = 14,
    maxFullEventKB = 512,
  } = {}) {
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
    this.startedAt = Date.now();
  }

  async start(meta = {}) {
    if (!this.enabled) return null;
    const runId = safeName(meta.runId ?? `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(this.rootDir, { recursive: true });
    await this.rotate();
    this.runDir = path.join(this.rootDir, runId);
    this.eventsPath = path.join(this.runDir, 'events.jsonl');
    await fs.mkdir(this.runDir, { recursive: true });
    await fs.writeFile(path.join(this.runDir, 'manifest.json'), `${JSON.stringify({
      version: 1,
      runId,
      startedAt: new Date(this.startedAt).toISOString(),
      level: this.level,
      ...meta,
    }, null, 2)}\n`, 'utf8');
    await this.record({ type: 'run_start', ...meta });
    return this.runDir;
  }

  record(event = {}) {
    if (!this.enabled || !this.eventsPath) return Promise.resolve();
    const type = String(event.type ?? 'event');
    this.counts.set(type, (this.counts.get(type) ?? 0) + 1);
    const payload = compactValue({
      at: new Date().toISOString(),
      ...event,
    }, this.level, this.maxFullBytes);
    const line = `${JSON.stringify(payload)}\n`;
    this.queue = this.queue
      .then(() => fs.appendFile(this.eventsPath, line, 'utf8'))
      .catch(() => {});
    return this.queue;
  }

  async finish({ status = 'complete', usage = null, stats = null, error = null } = {}) {
    if (!this.enabled || !this.runDir) return null;
    await this.record({ type: 'run_end', status, usage, stats, error });
    await this.queue;
    const summary = {
      status,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - this.startedAt,
      level: this.level,
      eventCounts: Object.fromEntries([...this.counts.entries()].sort(([a], [b]) => a.localeCompare(b))),
      usage,
      stats,
      error,
    };
    await fs.writeFile(path.join(this.runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await this.rotate();
    return this.runDir;
  }

  async rotate() {
    if (!this.enabled) return;
    let entries;
    try { entries = await fs.readdir(this.rootDir, { withFileTypes: true }); } catch { return; }
    const now = Date.now();
    const dirs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.rootDir, entry.name);
      try {
        const stat = await fs.stat(directory);
        dirs.push({ directory, mtimeMs: stat.mtimeMs, size: await directorySize(directory) });
      } catch {}
    }
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let total = dirs.reduce((sum, item) => sum + item.size, 0);
    for (let index = 0; index < dirs.length; index += 1) {
      const item = dirs[index];
      const overCount = index >= this.maxRuns;
      const tooOld = now - item.mtimeMs > this.maxAgeMs;
      const overSize = total > this.maxSizeBytes && item.directory !== this.runDir;
      if (!overCount && !tooOld && !overSize) continue;
      if (item.directory === this.runDir) continue;
      try {
        await fs.rm(item.directory, { recursive: true, force: true });
        total -= item.size;
      } catch {}
    }
  }
}

module.exports = { TrajectoryAudit, textInfo, compactValue, safeName, directorySize };
