'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PATH_PROBE_TOOL,
  MAX_CAPTURED_PROBE_OBSERVATIONS,
  REVIEWER_PATH_PROBE_PROMPT,
  normalizeProbeSpec,
  captureProbeObservation,
  injectPathProbeIntoReviewerClient,
} = require('../src/headless/reviewer-path-probe');

test('path probe confines fixture construction to the temporary sandbox', () => {
  assert.throws(
    () => normalizeProbeSpec({ directories: ['../outside'], cases: [{ artifact_path: 'result.json' }] }),
    /stay inside the temporary sandbox/i,
  );
  assert.throws(
    () => normalizeProbeSpec({ symlinks: [{ path: 'work/link', target: '/etc' }], cases: [{ artifact_path: 'link/file' }] }),
    /relative to the temporary sandbox/i,
  );
});

test('path probe preserves traversal strings as model-chosen resolver inputs', () => {
  const spec = normalizeProbeSpec({
    root_name: 'work',
    directories: ['outside'],
    symlinks: [{ path: 'work/escape', target: 'outside' }],
    cases: [
      { label: 'hostile', artifact_path: 'escape/../work/result.json' },
      { label: 'permitted-final-descendant', artifact_path: '../work/result.json' },
    ],
  });
  assert.equal(spec.cases[0].artifact_path, 'escape/../work/result.json');
  assert.equal(spec.cases[1].artifact_path, '../work/result.json');
});

test('captured probe evidence remains bounded and preserves revision provenance', () => {
  const sink = [];
  for (let index = 0; index < MAX_CAPTURED_PROBE_OBSERVATIONS + 2; index += 1) {
    captureProbeObservation(sink, {
      revision: `revision-${index}`,
      spec: { root_name: 'work', cases: [{ artifact_path: `case-${index}` }] },
      result: { results: [{ accepted: true }] },
    });
  }
  assert.equal(sink.length, MAX_CAPTURED_PROBE_OBSERVATIONS);
  assert.equal(sink[0].revision, 'revision-2');
  assert.equal(sink.at(-1).revision, `revision-${MAX_CAPTURED_PROBE_OBSERVATIONS + 1}`);
});

test('reviewer client injection adds only the isolated probe and provenance-sensitive guidance', async () => {
  const probeTool = { name: 'probe_path_resolution' };
  let received;
  const baseClient = {
    async createSession(options) {
      received = options;
      return { sessionId: 'reviewer' };
    },
  };
  const proxy = injectPathProbeIntoReviewerClient(null, baseClient, probeTool);
  const session = await proxy.createSession({
    tools: [{ name: 'report_review' }],
    availableTools: ['custom:report_review'],
    systemMessage: { mode: 'append', content: 'base reviewer prompt' },
  });

  assert.equal(session.sessionId, 'reviewer');
  assert.equal(received.tools.at(-1), probeTool);
  assert.ok(received.availableTools.includes(PATH_PROBE_TOOL));
  assert.match(received.systemMessage.content, /temporary filesystem fixture/i);
  assert.match(received.systemMessage.content, /restrictive rule/i);
  assert.match(received.systemMessage.content, /corresponding permissive rule/i);
  assert.match(received.systemMessage.content, /semantic boundary/i);
  assert.match(REVIEWER_PATH_PROBE_PROMPT, /final-state-only/i);
  assert.match(REVIEWER_PATH_PROBE_PROMPT, /provenance or mechanism/i);
  assert.match(REVIEWER_PATH_PROBE_PROMPT, /benign witness must actually exercise/i);
});