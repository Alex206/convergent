#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createClientOptions } = require('../copilot/runtime');
const { resolveHeadlessRoleModels } = require('./model-policy');

async function inspectModels({
  outputFile,
  coordinator = 'strong',
  workerA = 'adaptive',
  workerB = 'adaptive-diverse',
  reviewer = 'strong',
} = {}, dependencies = {}) {
  const sdk = dependencies.sdk ?? await import('@github/copilot-sdk');
  const runtime = createClientOptions(sdk, 'stdio', process.execPath);
  const client = dependencies.client ?? new sdk.CopilotClient(runtime.options);
  const ownsClient = !dependencies.client;

  if (ownsClient) await client.start();
  try {
    const available = await client.listModels();
    const resolution = resolveHeadlessRoleModels({ coordinator, workerA, workerB, reviewer }, available);
    const report = {
      generatedAt: new Date().toISOString(),
      runtimeTransport: runtime.transport,
      selectors: { coordinator, workerA, workerB, reviewer },
      availableCount: resolution.available.length,
      available: resolution.available,
      resolved: {
        coordinator: resolution.coordinator,
        reviewer: resolution.reviewer,
        workers: resolution.workers,
      },
      issues: resolution.issues,
      eligibleForDeterministicBenchmark: resolution.issues.length === 0,
      sendsAgentPrompts: false,
    };

    if (outputFile) {
      const target = path.resolve(outputFile);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }

    console.log(`Copilot model preflight: ${report.availableCount} available model(s); coordinator=${report.resolved.coordinator.id}; reviewer=${report.resolved.reviewer.id}; issues=${report.issues.length}; eligible=${report.eligibleForDeterministicBenchmark}.`);
    return report;
  } finally {
    if (ownsClient) await client.stop().catch(() => {});
  }
}

async function main() {
  const outputFile = process.argv[2];
  if (!outputFile) throw new Error('Usage: node src/headless/model-preflight.js <output-json>');
  await inspectModels({ outputFile });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}

module.exports = { inspectModels };
