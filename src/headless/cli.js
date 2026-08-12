#!/usr/bin/env node
'use strict';

const { parseArgs, runHeadless } = require('./runner');

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await runHeadless(options);
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
