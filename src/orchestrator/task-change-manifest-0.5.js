'use strict';

const crypto = require('node:crypto');
const base = require('./task-change-manifest');

function reviewEvidencePacketId(manifest) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(manifest ?? null))
    .digest('hex')
    .slice(0, 12);
}

function formatTaskChangeManifest(manifest, heading = 'TASK CHANGE MANIFEST') {
  const formatted = base.formatTaskChangeManifest(manifest, heading);
  if (!/for this review/i.test(String(heading))) return formatted;
  return [
    `SHARED DETERMINISTIC REVIEW EVIDENCE PACKET ${reviewEvidencePacketId(manifest)}`,
    formatted,
    '',
    'Reviewer efficiency contract: analyze this shared packet and the task acceptance criteria before using tools. The changed-path list and bounded diffs above are deterministic engine evidence shared identically with every reviewer. Do not run git status/diff, broad glob/rg discovery, re-fetch the issue/tracker, or reopen every changed file merely to reconstruct facts already present here. Use view/search/commands only to resolve a concrete uncertainty, inspect context omitted by the bounded diff, falsify a specific correctness hypothesis, or perform justified independent validation. Independent review means independent reasoning over shared evidence; it does not require three independent rediscovery passes.',
  ].join('\n');
}

module.exports = {
  ...base,
  formatTaskChangeManifest,
  reviewEvidencePacketId,
};
