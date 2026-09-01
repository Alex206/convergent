'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeProjectEvent } = require('./events');
const { applyProjectEvent, replayProjectEvents } = require('./state-machine');
const { text } = require('./model');

const EVENT_FILE = /^(\d{12})\.json$/;

function projectKey(projectId) {
  return crypto.createHash('sha256').update(text(projectId, 'projectId')).digest('hex');
}

function eventFileName(revision) {
  return `${String(revision).padStart(12, '0')}.json`;
}

class FileProjectEventStore {
  constructor(rootDirectory) {
    this.rootDirectory = path.resolve(text(rootDirectory, 'project event store root'));
  }

  projectDirectory(projectId) {
    return path.join(this.rootDirectory, projectKey(projectId));
  }

  async loadEvents(projectId) {
    const id = text(projectId, 'projectId');
    const directory = this.projectDirectory(id);
    let names;
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }

    const eventFiles = names.filter((name) => EVENT_FILE.test(name)).sort();
    let expectedRevision = 1;
    const events = [];
    for (const name of eventFiles) {
      const revision = Number(EVENT_FILE.exec(name)[1]);
      if (revision !== expectedRevision) {
        throw new Error(`Project '${id}' event log is not contiguous at revision ${expectedRevision}; found ${revision}.`);
      }
      const raw = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
      events.push(normalizeProjectEvent(raw));
      expectedRevision += 1;
    }

    if (events.length) {
      const state = replayProjectEvents(events);
      if (state.id !== id) throw new Error(`Stored project id '${state.id}' does not match requested project '${id}'.`);
    }
    return events;
  }

  async load(projectId) {
    const events = await this.loadEvents(projectId);
    return events.length ? replayProjectEvents(events) : null;
  }

  async append(projectId, rawEvent) {
    const id = text(projectId, 'projectId');
    const event = normalizeProjectEvent(rawEvent);
    const events = await this.loadEvents(id);
    const previous = events.length ? replayProjectEvents(events) : null;
    const next = applyProjectEvent(previous, event);
    if (previous && next.revision === previous.revision) return next;
    if (next.id !== id) throw new Error(`Event creates/targets project '${next.id}', not '${id}'.`);

    const directory = this.projectDirectory(id);
    await fs.mkdir(directory, { recursive: true });
    const finalPath = path.join(directory, eventFileName(next.revision));
    const temporaryPath = `${finalPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const handle = await fs.open(temporaryPath, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      // Linking a fully synced temporary inode into the immutable sequence slot is
      // atomic and fails if another writer already claimed this revision.
      await fs.link(temporaryPath, finalPath);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`Concurrent project event append detected at revision ${next.revision}.`);
      }
      throw error;
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
    return next;
  }
}

module.exports = {
  FileProjectEventStore,
  eventFileName,
  projectKey,
};