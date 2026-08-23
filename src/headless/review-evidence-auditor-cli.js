#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('./runner');
const { runWithStartupRetry } = require('./topology-cli');
const topologyEngineModule = require('./topology-engine');
const { ReviewEvidenceAuditorBenchmarkEngine } = require('./review-evidence-auditor');

class EnvironmentConfiguredReviewAuditorEngine extends ReviewEvidenceAuditorBenchmarkEngine {
  constructor(options = {}) {
    const auditorSelector = String(process.env.CONVERGENT_REVIEW_EVIDENCE_AUDITOR_MODEL ?? 'gpt-5.6-luna').trim();
    const experimentTopology = String(process.env.CONVERGENT_REVIEW_EVIDENCE_AUDITOR_TOPOLOGY ?? `review-audit-${auditorSelector}`).trim();
    super({
      ...options,
      reviewAuditorSelector: auditorSelector,
      experimentTopology,
    });
  }
}

topologyEngineModule.BenchmarkTopologyEngine = EnvironmentConfiguredReviewAuditorEngine;
const { runTopologyHeadless } = require('./topology-runner');

async function rewriteExperimentIdentity(outputDir, experimentTopology, auditorSelector) {
  const resultPath = path.join(outputDir, 'result.json');
  const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  result.topology = experimentTopology;
  result.topologyLabel = `Luna + Terra review + low-context ${auditorSelector} evidence audit`;
  result.reviewEvidenceAuditor = {
    selector: auditorSelector,
    lowContext: true,
    repositoryTools: false,
  };
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const metaPath = path.join(outputDir, 'review-evidence-auditor-meta.json');
  await fs.writeFile(metaPath, `${JSON.stringify({
    experimentTopology,
    auditorSelector,
    lowContext: true,
    repositoryTools: false,
  }, null, 2)}\n`, 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const auditorSelector = String(process.env.CONVERGENT_REVIEW_EVIDENCE_AUDITOR_MODEL ?? 'gpt-5.6-luna').trim();
  const experimentTopology = String(process.env.CONVERGENT_REVIEW_EVIDENCE_AUDITOR_TOPOLOGY ?? `review-audit-${auditorSelector}`).trim();

  options.topology = 'luna-terra-structured';
  await runWithStartupRetry(options, runTopologyHeadless);
  await rewriteExperimentIdentity(options.outputDir, experimentTopology, auditorSelector);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  EnvironmentConfiguredReviewAuditorEngine,
  rewriteExperimentIdentity,
  main,
};
