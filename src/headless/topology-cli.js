#!/usr/bin/env node
'use strict';

const { parseArgs } = require('./runner');
const { runTopologyHeadless } = require('./topology-runner');

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await runTopologyHeadless(options);
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
