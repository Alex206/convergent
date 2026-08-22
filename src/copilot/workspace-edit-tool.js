'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  normalizeWorkspaceFolders,
  findWorkspaceFolder,
  isWithinRoot,
  qualifiedWorkspacePath,
} = require('../orchestrator/workspace-scope');

const MAX_OPERATIONS = 20;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

function auditUi(ui, event) {
  try {
    if (typeof ui?.audit === 'function') void ui.audit(event);
    else void ui?.auditEvent?.(event);
  } catch {}
}

function hasGitComponent(relative) {
  return String(relative ?? '').split(/[\\/]+/).some((part) => part.toLowerCase() === '.git');
}

async function resolveWorkspaceEditTarget(workspace, workspaceFolders, workspaceFolder, requestedPath, operation) {
  const roots = normalizeWorkspaceFolders(workspace, workspaceFolders);
  const selected = findWorkspaceFolder(workspace, roots, workspaceFolder);
  if (!selected) throw new Error(`workspace_edit workspaceFolder is not one of the opened workspace folders: ${workspaceFolder}`);
  const value = String(requestedPath ?? '').trim();
  if (!value) throw new Error('workspace_edit requires a non-empty path.');
  const target = path.isAbsolute(value) ? path.resolve(value) : path.resolve(selected.path, value);
  if (!isWithinRoot(selected.path, target)) throw new Error(`workspace_edit path must stay inside workspace folder ${selected.name}: ${value}`);
  const relative = path.relative(selected.path, target);
  if (!relative || hasGitComponent(relative)) throw new Error(`workspace_edit refuses workspace-root or .git paths: ${value}`);

  const rootReal = await fs.realpath(selected.path);
  if (operation === 'create') {
    const parentReal = await fs.realpath(path.dirname(target));
    if (!isWithinRoot(rootReal, parentReal)) throw new Error(`workspace_edit create parent escapes workspace folder ${selected.name}: ${value}`);
  } else {
    const targetReal = await fs.realpath(target);
    if (!isWithinRoot(rootReal, targetReal)) throw new Error(`workspace_edit target escapes workspace folder ${selected.name}: ${value}`);
  }
  return {
    root: selected,
    target,
    relative,
    displayPath: qualifiedWorkspacePath(workspace, roots, selected, relative),
  };
}

async function approved(permissionHandler, target) {
  if (typeof permissionHandler !== 'function') return { ok: false, error: 'workspace_edit permission handler is unavailable.' };
  let decision;
  try {
    decision = await permissionHandler({ kind: 'write', fileName: target, path: target, toolName: 'workspace_edit' });
  } catch (error) {
    return { ok: false, error: `workspace_edit permission check failed: ${error.message ?? String(error)}` };
  }
  if (!String(decision?.kind ?? '').startsWith('approve')) return { ok: false, error: 'workspace_edit permission denied.' };
  return { ok: true };
}

function exactOccurrenceCount(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    if (count > 1) return count;
    offset = index + needle.length;
  }
}

function createWorkspaceEditTool(defineTool, {
  workspace,
  workspaceFolders = null,
  permissionHandler,
  owner = 'Worker',
  ui,
} = {}) {
  if (!workspace) throw new Error('createWorkspaceEditTool requires a primary workspace.');
  const roots = normalizeWorkspaceFolders(workspace, workspaceFolders);
  return defineTool('workspace_edit', {
    description: 'Apply bounded deterministic text-file mutations inside opened VS Code workspace folders. Prefer the normal built-in edit/create/apply_patch tools in the primary workspace folder. Use workspace_edit for writes in another opened workspace folder. Operations are sequential and support exact replace, create, and delete. Paths may not escape their selected workspace folder or traverse .git.',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_OPERATIONS,
          items: {
            type: 'object',
            properties: {
              workspaceFolder: { type: 'string', description: 'Exact opened VS Code workspace-folder name.' },
              path: { type: 'string', description: 'Path relative to workspaceFolder, or an absolute path inside that same folder.' },
              operation: { type: 'string', enum: ['replace', 'create', 'delete'] },
              oldText: { type: 'string', description: 'For replace: exact text that must occur exactly once.' },
              newText: { type: 'string', description: 'For replace: replacement text; may be empty.' },
              content: { type: 'string', description: 'For create: complete UTF-8 file content.' },
            },
            required: ['workspaceFolder', 'path', 'operation'],
            additionalProperties: false,
          },
        },
      },
      required: ['operations'],
      additionalProperties: false,
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args = {}) => {
      const operations = Array.isArray(args.operations) ? args.operations : [];
      if (!operations.length || operations.length > MAX_OPERATIONS) {
        return { accepted: false, error: `workspace_edit requires 1-${MAX_OPERATIONS} operations.` };
      }
      const results = [];
      for (let index = 0; index < operations.length; index += 1) {
        const item = operations[index] ?? {};
        const operation = String(item.operation ?? '');
        if (!['replace', 'create', 'delete'].includes(operation)) {
          return { accepted: false, failedIndex: index, error: `Unsupported workspace_edit operation: ${operation}` };
        }
        let resolved;
        try {
          resolved = await resolveWorkspaceEditTarget(workspace, roots, item.workspaceFolder, item.path, operation);
        } catch (error) {
          return { accepted: false, failedIndex: index, error: error.message ?? String(error) };
        }
        const permission = await approved(permissionHandler, resolved.target);
        if (!permission.ok) {
          auditUi(ui, { type: 'workspace_edit_permission_denied', agent: owner, path: resolved.displayPath, operation });
          return { accepted: false, failedIndex: index, error: permission.error };
        }
        try {
          if (operation === 'replace') {
            const oldText = String(item.oldText ?? '');
            const newText = String(item.newText ?? '');
            if (!oldText) throw new Error('replace requires non-empty oldText.');
            const current = await fs.readFile(resolved.target, 'utf8');
            if (current.includes('\u0000')) throw new Error('workspace_edit supports UTF-8 text files only.');
            if (Buffer.byteLength(current) > MAX_TEXT_BYTES) throw new Error(`workspace_edit refuses text files larger than ${MAX_TEXT_BYTES} bytes.`);
            const occurrences = exactOccurrenceCount(current, oldText);
            if (occurrences !== 1) throw new Error(`replace oldText must occur exactly once; found ${occurrences}.`);
            await fs.writeFile(resolved.target, current.replace(oldText, newText), 'utf8');
          } else if (operation === 'create') {
            const content = String(item.content ?? '');
            if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new Error(`workspace_edit refuses new text larger than ${MAX_TEXT_BYTES} bytes.`);
            await fs.writeFile(resolved.target, content, { encoding: 'utf8', flag: 'wx' });
          } else {
            const stat = await fs.lstat(resolved.target);
            if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('workspace_edit delete supports files only.');
            await fs.unlink(resolved.target);
          }
        } catch (error) {
          return { accepted: false, failedIndex: index, path: resolved.displayPath, error: error.message ?? String(error) };
        }
        results.push({ operation, path: resolved.displayPath });
        auditUi(ui, { type: 'workspace_edit_applied', agent: owner, path: resolved.displayPath, operation });
      }
      return { accepted: true, results };
    },
  });
}

module.exports = {
  createWorkspaceEditTool,
  resolveWorkspaceEditTarget,
  exactOccurrenceCount,
  MAX_OPERATIONS,
  MAX_TEXT_BYTES,
};
