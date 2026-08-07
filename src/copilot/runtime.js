'use strict';

const VALID_TRANSPORTS = new Set(['auto', 'stdio', 'inprocess']);

function executableName(execPath = process.execPath) {
  const parts = String(execPath || '').split(/[\\/]/);
  return (parts.at(-1) || '').toLowerCase();
}

function isNodeExecutable(execPath = process.execPath) {
  const executable = executableName(execPath);
  return executable === 'node' || executable === 'node.exe';
}

function resolveRuntimeTransport(requested = 'auto', execPath = process.execPath) {
  if (!VALID_TRANSPORTS.has(requested)) {
    throw new Error(`Unsupported Copilot runtime transport: ${requested}`);
  }

  if (requested !== 'auto') return requested;

  // @github/copilot-sdk 1.0.8 launches its bundled JS CLI with process.execPath.
  // In a normal Node process that is node(.exe), but inside the VS Code Extension
  // Host it is Code(.exe)/Electron. Using stdio there makes the SDK effectively run
  // `Code.exe <copilot-cli.js> ...`, so VS Code's own CLI parser consumes the script
  // path and the Copilot runtime never starts. The SDK's in-process transport avoids
  // that launcher path and is therefore the safe automatic choice in an extension host.
  return isNodeExecutable(execPath) ? 'stdio' : 'inprocess';
}

function createClientOptions(sdk, requested = 'auto', execPath = process.execPath) {
  const transport = resolveRuntimeTransport(requested, execPath);

  if (transport === 'inprocess') {
    if (!sdk.RuntimeConnection?.forInProcess) {
      throw new Error('The installed Copilot SDK does not provide the in-process runtime transport.');
    }
    return {
      transport,
      options: {
        connection: sdk.RuntimeConnection.forInProcess(),
      },
    };
  }

  return { transport, options: {} };
}

module.exports = {
  executableName,
  isNodeExecutable,
  resolveRuntimeTransport,
  createClientOptions,
};
