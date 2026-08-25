'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { ManagedCommandRuntime, DEFAULT_TIMEOUT_MS } = require('../runtime/local-command-backend');
const { workspaceRevision } = require('./revision');
const { normalizeWorkspaceFolders, findWorkspaceFolder, rootForPath } = require('./workspace-scope');

const GATE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const GATE_POLICIES = new Set(['required', 'advisory']);
const SUPPORTED_PLATFORMS = new Set(['aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32']);
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
const MAX_COMMAND_CHARS = 16_384;
const MAX_WORKSPACE_FOLDER_CHARS = 256;

function validationError(message) {
  const error = new Error(`Invalid validation gate: ${message}`);
  error.code = 'CONVERGENT_INVALID_VALIDATION_GATE';
  return error;
}

function normalizeRelativeCwd(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const cwd = String(value).trim();
  if (cwd.includes('\0')) throw validationError('cwd must not contain NUL bytes.');
  if (path.posix.isAbsolute(cwd) || path.win32.isAbsolute(cwd)) {
    throw validationError('cwd must be repository-relative, not absolute.');
  }
  const parts = cwd.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
  if (parts[0] === '..' || parts.includes('..')) {
    throw validationError('cwd must stay inside the selected workspace root.');
  }
  return parts.length ? parts.join('/') : null;
}

function normalizeWorkspaceFolder(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const name = String(value).trim();
  if (name.includes('\0')) throw validationError('workspaceFolder must not contain NUL bytes.');
  if (name.length > MAX_WORKSPACE_FOLDER_CHARS) {
    throw validationError(`workspaceFolder must be at most ${MAX_WORKSPACE_FOLDER_CHARS} characters.`);
  }
  return name;
}

function normalizePlatforms(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validationError('platforms must be an array when supplied.');
  const result = [...new Set(value.map((entry) => String(entry ?? '').trim().toLowerCase()).filter(Boolean))].sort();
  for (const platform of result) {
    if (!SUPPORTED_PLATFORMS.has(platform)) {
      throw validationError(`unsupported platform ${JSON.stringify(platform)}.`);
    }
  }
  return result;
}

function normalizeTimeoutMs(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    throw validationError(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`);
  }
  return parsed;
}

function gateIdentityPayload(gate) {
  return {
    id: gate.id,
    command: gate.command,
    policy: gate.policy,
    timeoutMs: gate.timeoutMs,
    workspaceFolder: gate.workspaceFolder,
    cwd: gate.cwd,
    platforms: gate.platforms,
  };
}

function validatorIdentity(gate) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(gateIdentityPayload(gate))).digest('hex');
  return `gate:${gate.id}:sha256:${digest}`;
}

function normalizeValidationGate(definition = {}) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw validationError('definition must be an object.');
  }

  const id = String(definition.id ?? '').trim().toLowerCase();
  if (!GATE_ID_PATTERN.test(id)) {
    throw validationError('id must be 1-64 lowercase letters/digits/dot/underscore/hyphen, beginning and ending with a letter or digit.');
  }

  const command = String(definition.command ?? '').trim();
  if (!command) throw validationError('command must be a non-empty string.');
  if (command.length > MAX_COMMAND_CHARS) throw validationError(`command must be at most ${MAX_COMMAND_CHARS} characters.`);
  if (command.includes('\0')) throw validationError('command must not contain NUL bytes.');

  const policy = String(definition.policy ?? 'required').trim().toLowerCase();
  if (!GATE_POLICIES.has(policy)) throw validationError('policy must be required or advisory.');

  const gate = {
    id,
    command,
    policy,
    timeoutMs: normalizeTimeoutMs(definition.timeoutMs),
    workspaceFolder: normalizeWorkspaceFolder(definition.workspaceFolder),
    cwd: normalizeRelativeCwd(definition.cwd),
    platforms: normalizePlatforms(definition.platforms),
  };
  return Object.freeze({ ...gate, validatorId: validatorIdentity(gate) });
}

function validationGateApplies(gate, platform = process.platform) {
  const normalized = normalizeValidationGate(gate);
  return normalized.platforms.length === 0 || normalized.platforms.includes(String(platform));
}

function resolveValidationGateCwd(gate, workspace, workspaceFolders = null) {
  const normalized = normalizeValidationGate(gate);
  const roots = normalizeWorkspaceFolders(workspace, workspaceFolders);
  const selected = findWorkspaceFolder(workspace, roots, normalized.workspaceFolder);
  if (!selected) {
    throw new Error(`Validation gate workspaceFolder is not one of the opened workspace folders: ${normalized.workspaceFolder}`);
  }
  const absolute = normalized.cwd ? path.resolve(selected.path, normalized.cwd) : path.resolve(selected.path);
  const owner = rootForPath(workspace, roots, absolute);
  if (!owner || path.resolve(owner.path) !== path.resolve(selected.path)) {
    throw new Error(`Validation gate cwd must stay inside workspace folder ${selected.name}: ${normalized.cwd ?? '.'}`);
  }
  const primary = roots[0];
  const runtimeCwd = path.resolve(selected.path) === path.resolve(primary.path)
    ? (normalized.cwd ?? null)
    : absolute;
  return Object.freeze({ root: selected, absolute, runtimeCwd });
}

function successfulCommand(result) {
  return Boolean(result)
    && result.state === 'completed'
    && result.exitCode === 0
    && !result.error;
}

function buildValidationGateEvidence({
  gate,
  beforeRevision,
  afterRevision,
  expectedRevision = null,
  commandResult = null,
  executionError = null,
}) {
  const normalized = normalizeValidationGate(gate);
  const revisionAvailable = typeof beforeRevision === 'string' && beforeRevision.length > 0
    && typeof afterRevision === 'string' && afterRevision.length > 0;
  const revisionStable = revisionAvailable && beforeRevision === afterRevision;
  const expected = typeof expectedRevision === 'string' && expectedRevision.length > 0 ? expectedRevision : null;
  const candidateRevisionMatched = expected === null
    ? null
    : (typeof beforeRevision === 'string' && beforeRevision === expected);

  let outcome;
  if (!revisionAvailable) outcome = 'revision_unavailable';
  else if (expected !== null && !candidateRevisionMatched) outcome = 'candidate_changed';
  else if (!revisionStable) outcome = 'invalidated';
  else if (!executionError && successfulCommand(commandResult)) outcome = 'passed';
  else outcome = 'failed';

  const blocksAcceptance = outcome === 'candidate_changed'
    || outcome === 'invalidated'
    || outcome === 'revision_unavailable'
    || (normalized.policy === 'required' && outcome !== 'passed');

  return Object.freeze({
    gateId: normalized.id,
    validatorId: normalized.validatorId,
    policy: normalized.policy,
    workspaceFolder: normalized.workspaceFolder,
    cwd: normalized.cwd,
    outcome,
    blocksAcceptance,
    revisionStable,
    expectedRevision: expected,
    candidateRevisionMatched,
    beforeRevision: beforeRevision ?? null,
    afterRevision: afterRevision ?? null,
    commandResult,
    executionError: executionError ? String(executionError.message ?? executionError) : null,
  });
}

function skippedValidationGateEvidence(gate, platform = process.platform) {
  const normalized = normalizeValidationGate(gate);
  return Object.freeze({
    gateId: normalized.id,
    validatorId: normalized.validatorId,
    policy: normalized.policy,
    workspaceFolder: normalized.workspaceFolder,
    cwd: normalized.cwd,
    outcome: 'skipped',
    blocksAcceptance: false,
    revisionStable: null,
    expectedRevision: null,
    candidateRevisionMatched: null,
    beforeRevision: null,
    afterRevision: null,
    commandResult: null,
    executionError: null,
    skippedForPlatform: String(platform),
  });
}

function notRunValidationGateEvidence(gate, reason, expectedRevision = null) {
  const normalized = normalizeValidationGate(gate);
  return Object.freeze({
    gateId: normalized.id,
    validatorId: normalized.validatorId,
    policy: normalized.policy,
    workspaceFolder: normalized.workspaceFolder,
    cwd: normalized.cwd,
    outcome: 'not_run',
    blocksAcceptance: normalized.policy === 'required',
    revisionStable: null,
    expectedRevision,
    candidateRevisionMatched: null,
    beforeRevision: null,
    afterRevision: null,
    commandResult: null,
    executionError: null,
    notRunReason: String(reason),
  });
}

function validationGateEvidenceIsCurrent(evidence, currentRevision) {
  return Boolean(evidence)
    && evidence.outcome === 'passed'
    && evidence.revisionStable === true
    && typeof currentRevision === 'string'
    && evidence.afterRevision === currentRevision;
}

async function authorizeValidationGateCommand(gate, { permissionHandler, workspace, workspaceFolders = null } = {}) {
  if (typeof permissionHandler !== 'function') {
    throw new Error('Validation gate permission handler is unavailable; command was not started.');
  }
  const cwd = resolveValidationGateCwd(gate, workspace, workspaceFolders);
  const permission = await permissionHandler({
    kind: 'shell',
    fullCommandText: gate.command,
    cwd: cwd.absolute,
    toolName: 'validation_gate',
  });
  if (!String(permission?.kind ?? '').startsWith('approve')) {
    throw new Error('Validation gate permission denied; command was not started.');
  }
  return cwd;
}

async function readRevision(revision, workspace, workspaceFolders) {
  return revision(workspace, workspaceFolders);
}

async function runValidationGate(definition, options = {}) {
  const gate = normalizeValidationGate(definition);
  const platform = String(options.platform ?? process.platform);
  if (!validationGateApplies(gate, platform)) return skippedValidationGateEvidence(gate, platform);

  const revision = options.revision ?? workspaceRevision;
  const workspace = options.workspace;
  const workspaceFolders = options.workspaceFolders ?? null;
  const expectedRevision = typeof options.expectedRevision === 'string' && options.expectedRevision.length > 0
    ? options.expectedRevision
    : null;
  if (!workspace) throw new Error('Validation gate execution requires a workspace directory.');

  let beforeRevision;
  try {
    beforeRevision = await readRevision(revision, workspace, workspaceFolders);
  } catch (error) {
    return buildValidationGateEvidence({ gate, beforeRevision: null, afterRevision: null, expectedRevision, executionError: error });
  }

  if (expectedRevision !== null && beforeRevision !== expectedRevision) {
    return buildValidationGateEvidence({ gate, beforeRevision, afterRevision: beforeRevision, expectedRevision });
  }

  const runtime = options.runtime ?? new ManagedCommandRuntime({ workspace, workspaceFolders });
  let commandResult = null;
  let executionError = null;
  let cwd = null;
  try {
    cwd = await authorizeValidationGateCommand(gate, {
      permissionHandler: options.permissionHandler,
      workspace,
      workspaceFolders,
    });
  } catch (error) {
    executionError = error;
  }

  if (!executionError) {
    let preExecutionRevision = null;
    try {
      preExecutionRevision = await readRevision(revision, workspace, workspaceFolders);
    } catch (error) {
      return buildValidationGateEvidence({ gate, beforeRevision, afterRevision: null, expectedRevision, executionError: error });
    }
    if (preExecutionRevision !== beforeRevision) {
      return buildValidationGateEvidence({
        gate,
        beforeRevision,
        afterRevision: preExecutionRevision,
        expectedRevision,
        executionError: new Error('Workspace revision changed after gate permission and before command start; command was not started.'),
      });
    }

    try {
      commandResult = await runtime.execute(`validation-gate:${gate.id}`, {
        command: gate.command,
        cwd: cwd.runtimeCwd,
        timeoutMs: gate.timeoutMs,
        onStart: options.onStart,
        onOutput: options.onOutput,
      });
    } catch (error) {
      executionError = error;
    }
  }

  let afterRevision = null;
  try {
    afterRevision = await readRevision(revision, workspace, workspaceFolders);
  } catch (error) {
    executionError = executionError ?? error;
  }

  return buildValidationGateEvidence({
    gate,
    beforeRevision,
    afterRevision,
    expectedRevision,
    commandResult,
    executionError,
  });
}

async function runValidationGates(definitions, options = {}) {
  if (!Array.isArray(definitions)) throw new Error('Validation gate set must be an array.');
  const gates = definitions.map((definition) => normalizeValidationGate(definition));
  const platform = String(options.platform ?? process.platform);
  const applicable = gates.filter((gate) => validationGateApplies(gate, platform));
  if (applicable.length === 0) {
    return Object.freeze({
      candidateRevision: null,
      currentRevision: null,
      accepted: true,
      blocksAcceptance: false,
      completedAllApplicable: true,
      requiredApplicable: 0,
      requiredPassed: 0,
      evidences: Object.freeze(gates.map((gate) => skippedValidationGateEvidence(gate, platform))),
      revisionError: null,
    });
  }

  const workspace = options.workspace;
  const workspaceFolders = options.workspaceFolders ?? null;
  const revision = options.revision ?? workspaceRevision;
  if (!workspace) throw new Error('Validation gate execution requires a workspace directory.');

  let candidateRevision;
  try {
    candidateRevision = await readRevision(revision, workspace, workspaceFolders);
  } catch (error) {
    const evidences = gates.map((gate) => validationGateApplies(gate, platform)
      ? buildValidationGateEvidence({ gate, beforeRevision: null, afterRevision: null, executionError: error })
      : skippedValidationGateEvidence(gate, platform));
    return Object.freeze({
      candidateRevision: null,
      currentRevision: null,
      accepted: false,
      blocksAcceptance: true,
      completedAllApplicable: false,
      requiredApplicable: applicable.filter((gate) => gate.policy === 'required').length,
      requiredPassed: 0,
      evidences: Object.freeze(evidences),
      revisionError: String(error.message ?? error),
    });
  }

  const runtime = options.runtime ?? new ManagedCommandRuntime({ workspace, workspaceFolders });
  const evidences = [];
  let halted = false;
  let haltReason = null;
  for (const gate of gates) {
    if (!validationGateApplies(gate, platform)) {
      evidences.push(skippedValidationGateEvidence(gate, platform));
      continue;
    }
    if (halted) {
      evidences.push(notRunValidationGateEvidence(gate, haltReason, candidateRevision));
      continue;
    }
    const evidence = await runValidationGate(gate, {
      ...options,
      runtime,
      revision,
      expectedRevision: candidateRevision,
    });
    evidences.push(evidence);
    if (['candidate_changed', 'invalidated', 'revision_unavailable'].includes(evidence.outcome)) {
      halted = true;
      haltReason = `previous gate ${gate.id} produced ${evidence.outcome}`;
    }
  }

  let currentRevision = null;
  let revisionError = null;
  try {
    currentRevision = await readRevision(revision, workspace, workspaceFolders);
  } catch (error) {
    revisionError = String(error.message ?? error);
  }

  const requiredApplicable = applicable.filter((gate) => gate.policy === 'required').length;
  const requiredPassed = evidences.filter((evidence) => evidence.policy === 'required'
    && evidence.outcome === 'passed'
    && currentRevision !== null
    && validationGateEvidenceIsCurrent(evidence, currentRevision)).length;
  const completedAllApplicable = !evidences.some((evidence) => evidence.outcome === 'not_run');
  const revisionStillCurrent = currentRevision !== null && currentRevision === candidateRevision;
  const blocksAcceptance = Boolean(revisionError)
    || !revisionStillCurrent
    || !completedAllApplicable
    || evidences.some((evidence) => evidence.blocksAcceptance);

  return Object.freeze({
    candidateRevision,
    currentRevision,
    accepted: !blocksAcceptance,
    blocksAcceptance,
    completedAllApplicable,
    requiredApplicable,
    requiredPassed,
    evidences: Object.freeze(evidences),
    revisionError,
  });
}

module.exports = {
  GATE_ID_PATTERN,
  GATE_POLICIES,
  SUPPORTED_PLATFORMS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_COMMAND_CHARS,
  MAX_WORKSPACE_FOLDER_CHARS,
  normalizeValidationGate,
  validationGateApplies,
  resolveValidationGateCwd,
  validatorIdentity,
  successfulCommand,
  buildValidationGateEvidence,
  skippedValidationGateEvidence,
  notRunValidationGateEvidence,
  validationGateEvidenceIsCurrent,
  authorizeValidationGateCommand,
  runValidationGate,
  runValidationGates,
};
