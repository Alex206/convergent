#!/usr/bin/env node
'use strict';

const { parseArgs } = require('./runner');
const { normalizeBenchmarkArchitecture } = require('./architecture-catalog');
const { runArchitectureBenchmark } = require('./architecture-runner');

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.architecture = normalizeBenchmarkArchitecture(options.architecture);
  await runArchitectureBenchmark(options);
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
