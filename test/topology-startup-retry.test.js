'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  isRetryableStartupStall,
  runWithStartupRetry,
} = require('../src/headless/topology-cli');

test('only zero-call agent inactivity is a retryable benchmark startup stall', () => {
  assert.equal(isRetryableStartupStall({
    status: 'failed',
    error: 'Worker A produced no agent/tool activity for 181s.',
    usage: { calls: 0 },
  }), true);
  assert.equal(isRetryableStartupStall({
    status: 'failed',
    error: 'Worker A produced no agent/tool activity for 181s.',
    usage: { calls: 1 },
  }), false);
  assert.equal(isRetryableStartupStall({
    status: 'failed',
    error: 'Worker A reported BLOCKED.',
    usage: { calls: 0 },
  }), false);
});

test('topology CLI retries one zero-call startup stall and preserves evidence', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-startup-retry-'));
  let attempts = 0;
  const runner = async () => {
    attempts += 1;
    if (attempts === 1) {
      await fs.writeFile(path.join(outputDir, 'result.json'), JSON.stringify({
        status: 'failed',
        error: 'Worker A produced no agent/tool activity for 181s.',
        usage: { calls: 0, inputTokens: 0, aiCredits: 0 },
      }));
      throw new Error('Worker A produced no agent/tool activity for 181s.');
    }
    await fs.writeFile(path.join(outputDir, 'result.json'), JSON.stringify({
      status: 'complete',
      usage: { calls: 5 },
    }));
    return { ok: true };
  };

  const result = await runWithStartupRetry({ outputDir }, runner);
  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
  const retryRecords = JSON.parse(await fs.readFile(path.join(outputDir, 'startup-retries.json'), 'utf8'));
  assert.equal(retryRecords.length, 1);
  assert.match(retryRecords[0].reason, /no agent\/tool activity/);
  const firstAttempt = JSON.parse(await fs.readFile(
    path.join(outputDir, 'startup-stall-attempt-1-result.json'),
    'utf8',
  ));
  assert.equal(firstAttempt.usage.calls, 0);
});

test('topology CLI does not retry a substantive failure', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-no-retry-'));
  let attempts = 0;
  const runner = async () => {
    attempts += 1;
    await fs.writeFile(path.join(outputDir, 'result.json'), JSON.stringify({
      status: 'failed',
      error: 'Worker A reported BLOCKED.',
      usage: { calls: 3 },
    }));
    throw new Error('Worker A reported BLOCKED.');
  };

  await assert.rejects(() => runWithStartupRetry({ outputDir }, runner), /BLOCKED/);
  assert.equal(attempts, 1);
});
