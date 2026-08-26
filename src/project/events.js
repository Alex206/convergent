'use strict';

const crypto = require('node:crypto');
const { text } = require('./model');

const PROJECT_EVENT_TYPES = Object.freeze([
  'PROJECT_CREATED',
  'DISCOVERY_STARTED',
  'QUESTION_RAISED',
  'QUESTION_ANSWERED',
  'USE_CASE_ADDED',
  'REQUIREMENT_ADDED',
  'REQUIREMENT_REVISED',
  'DECISION_RECORDED',
  'PLAN_PROPOSED',
  'PLAN_APPROVED',
  'PLAN_REVISED',
  'MILESTONE_STARTED',
  'MILESTONE_READY_FOR_REVIEW',
  'MILESTONE_ACCEPTED',
  'FEEDBACK_RECEIVED',
  'BUDGET_RESERVED',
  'BUDGET_RELEASED',
  'BUDGET_SPENT',
  'EXECUTION_TARGET_SELECTED',
  'PROJECT_PAUSED',
  'PROJECT_RESUMED',
  'PROJECT_COMPLETED',
]);

const EVENT_TYPE_SET = new Set(PROJECT_EVENT_TYPES);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function normalizeProjectEvent(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Project event must be an object.');
  }
  const id = text(value.id, 'event id');
  const type = text(value.type, 'event type').toUpperCase();
  if (!EVENT_TYPE_SET.has(type)) throw new Error(`Unknown project event type '${type}'.`);
  const data = value.data === undefined ? {} : value.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Project event data must be an object.');
  }

  let at = null;
  if (value.at !== undefined && value.at !== null && value.at !== '') {
    at = text(value.at, 'event timestamp');
    if (Number.isNaN(Date.parse(at))) throw new Error(`Invalid project event timestamp '${at}'.`);
  }

  return {
    id,
    type,
    ...(at ? { at } : {}),
    data: canonicalize(data),
  };
}

function projectEventFingerprint(event) {
  const normalized = normalizeProjectEvent(event);
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(normalized))).digest('hex');
}

module.exports = {
  PROJECT_EVENT_TYPES,
  normalizeProjectEvent,
  projectEventFingerprint,
};