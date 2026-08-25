'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeWorkspaceFolders } = require('./workspace-scope');
const { normalizeValidationGate } = require('./validation-gates');

const VALIDATION_GATE_CONFIG_RELATIVE_PATH = '.convergent/validation-gates.json';
const VALIDATION_GATE_CONFIG_VERSION = 1;
const MAX_GATES_PER_ROOT = 32;
const TOP_LEVEL_KEYS = new Set(['version', 'gates']);
const REPOSITORY_GATE_KEYS = new Set(['id', 'command', 'policy', 'timeoutMs', 'cwd', 'platforms']);

function configError(message, source = VALIDATION_GATE_CONFIG_RELATIVE_PATH) {
  const error = new Error(`Invalid validation gate config ${source}: ${message}`);
  error.code = 'CONVERGENT_INVALID_VALIDATION_GATE_CONFIG';
  return error;
}

function assertPlainObject(value, label, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError(`${label} must be an object.`, source);
  }
}

function rejectUnknownKeys(value, allowed, label, source) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw configError(`${label} contains unsupported key${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`, source);
}

function parseValidationGateConfig(text, { workspaceFolder, source = VALIDATION_GATE_CONFIG_RELATIVE_PATH } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch (error) {
    throw configError(`JSON parse failed: ${error.message}`, source);
  }
  assertPlainObject(parsed, 'root value', source);
  rejectUnknownKeys(parsed, TOP_LEVEL_KEYS, 'root value', source);

  if (parsed.version !== VALIDATION_GATE_CONFIG_VERSION) {
    throw configError(`version must be ${VALIDATION_GATE_CONFIG_VERSION}.`, source);
  }
  if (!Array.isArray(parsed.gates)) throw configError('gates must be an array.', source);
  if (parsed.gates.length > MAX_GATES_PER_ROOT) {
    throw configError(`gates may contain at most ${MAX_GATES_PER_ROOT} entries.`, source);
  }

  const seen = new Set();
  const gates = parsed.gates.map((definition, index) => {
    assertPlainObject(definition, `gates[${index}]`, source);
    rejectUnknownKeys(definition, REPOSITORY_GATE_KEYS, `gates[${index}]`, source);
    let gate;
    try {
      gate = normalizeValidationGate({ ...definition, workspaceFolder });
    } catch (error) {
      throw configError(`gates[${index}] is invalid: ${error.message}`, source);
    }
    if (seen.has(gate.id)) throw configError(`duplicate gate id ${JSON.stringify(gate.id)}.`, source);
    seen.add(gate.id);
    return gate;
  });

  return Object.freeze({ version: VALIDATION_GATE_CONFIG_VERSION, gates: Object.freeze(gates) });
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function loadValidationGateConfigForRoot(root, options = {}) {
  const fsApi = options.fs ?? fs;
  const configPath = path.join(root.path, VALIDATION_GATE_CONFIG_RELATIVE_PATH);
  let stat;
  try {
    stat = await fsApi.lstat(configPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ root, path: configPath, present: false, gates: Object.freeze([]) });
    throw error;
  }

  if (stat.isSymbolicLink()) throw configError('config file must not be a symbolic link.', configPath);
  if (!stat.isFile()) throw configError('config path must be a regular file.', configPath);

  const [realRoot, realConfig] = await Promise.all([fsApi.realpath(root.path), fsApi.realpath(configPath)]);
  if (!pathIsInside(realRoot, realConfig)) {
    throw configError('resolved config path leaves the repository root.', configPath);
  }

  const parsed = parseValidationGateConfig(await fsApi.readFile(configPath, 'utf8'), {
    workspaceFolder: root.name,
    source: configPath,
  });
  return Object.freeze({ root, path: configPath, present: true, gates: parsed.gates });
}

async function loadRepositoryValidationGates(workspace, workspaceFolders = null, options = {}) {
  const roots = normalizeWorkspaceFolders(workspace, workspaceFolders);
  const configs = [];
  const gates = [];
  for (const root of roots) {
    const config = await loadValidationGateConfigForRoot(root, options);
    configs.push(config);
    gates.push(...config.gates);
  }
  return Object.freeze({ configs: Object.freeze(configs), gates: Object.freeze(gates) });
}

module.exports = {
  VALIDATION_GATE_CONFIG_RELATIVE_PATH,
  VALIDATION_GATE_CONFIG_VERSION,
  MAX_GATES_PER_ROOT,
  parseValidationGateConfig,
  pathIsInside,
  loadValidationGateConfigForRoot,
  loadRepositoryValidationGates,
};
