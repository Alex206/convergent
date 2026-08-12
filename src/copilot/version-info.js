'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readPackage(root, packageName) {
  const packagePath = path.join(root, 'node_modules', ...packageName.split('/'), 'package.json');
  try {
    const value = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return {
      name: value.name ?? packageName,
      version: value.version ?? null,
      path: packagePath,
    };
  } catch (error) {
    return {
      name: packageName,
      version: null,
      path: packagePath,
      error: error?.code ?? error?.message ?? String(error),
    };
  }
}

function runtimeVersionInfo(root = path.resolve(__dirname, '../..')) {
  const sdk = readPackage(root, '@github/copilot-sdk');
  const cli = readPackage(root, '@github/copilot');
  const platformPackages = [
    '@github/copilot-win32-x64',
    '@github/copilot-win32-arm64',
    '@github/copilot-linux-x64',
    '@github/copilot-linux-arm64',
    '@github/copilot-linuxmusl-x64',
    '@github/copilot-linuxmusl-arm64',
    '@github/copilot-darwin-x64',
    '@github/copilot-darwin-arm64',
  ];
  const installedPlatforms = platformPackages
    .map((name) => readPackage(root, name))
    .filter((entry) => entry.version);

  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    sdk: { name: sdk.name, version: sdk.version, error: sdk.error },
    cli: { name: cli.name, version: cli.version, error: cli.error },
    platformPackages: installedPlatforms.map(({ name, version }) => ({ name, version })),
  };
}

module.exports = { readPackage, runtimeVersionInfo };
