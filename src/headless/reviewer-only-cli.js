#!/usr/bin/env node
'use strict';

const { parseArgs } = require('./runner');
const { reviewArmConfig } = require('./equalized-review-protocols');
const { runReviewerOnlyHeadless } = require('./reviewer-only-runner');

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.arm = reviewArmConfig(options.arm).arm;
  await runReviewerOnlyHeadless(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}

module.exports = { main };
