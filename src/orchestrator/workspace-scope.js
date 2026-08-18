'use strict';
const path = require('node:path');
function key(value) { const resolved = path.resolve(String(value ?? '')); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
function uniqueName(base, used) { let name = String(base || 'workspace').trim() || 'workspace'; if (!used.has(name.toLowerCase())) { used.add(name.toLowerCase()); return name; } let i = 2; while (used.has(`${name.toLowerCase()}-${i}`)) i += 1; const result = `${name}-${i}`; used.add(result.toLowerCase()); return result; }
function normalizeWorkspaceFolders(primary, folders = null) {
  const primaryPath = path.resolve(String(primary ?? ''));
  const candidates = Array.isArray(folders) && folders.length ? folders : [{ name: path.basename(primaryPath) || 'workspace', path: primaryPath }];
  const seen = new Set(); const usedNames = new Set(); const roots = [];
  const primaryEntry = candidates.find((entry) => key(entry?.path ?? entry?.uri?.fsPath ?? entry) === key(primaryPath));
  const add = (entry) => { const rootPath = path.resolve(String(entry?.path ?? entry?.uri?.fsPath ?? entry ?? '')); const normalized = key(rootPath); if (seen.has(normalized)) return; seen.add(normalized); roots.push({ name: uniqueName(entry?.name ?? path.basename(rootPath) ?? 'workspace', usedNames), path: rootPath }); };
  add({ name: primaryEntry?.name ?? path.basename(primaryPath), path: primaryPath });
  for (const candidate of candidates) add(candidate);
  return roots;
}
function workspaceScopePrompt(primary, folders = null) {
  const roots = normalizeWorkspaceFolders(primary, folders); if (roots.length <= 1) return '';
  return ['MULTI-ROOT VS CODE WORKSPACE:', `The session working directory is the primary folder ${roots[0].name}: ${roots[0].path}`, 'All of the following opened workspace folders are in Convergent scope and may be inspected or modified when the task requires it:', ...roots.map((root, i) => `- ${i === 0 ? 'primary ' : ''}${root.name}: ${root.path}`), 'Relative built-in file-tool paths resolve from the primary folder. batch_view searches every listed folder and accepts folder-qualified or absolute paths in any listed folder. Modifying workers should keep the native edit/create/apply_patch tools for the primary folder and use workspace_edit for writes in another opened folder. workspace_edit accepts the exact workspace-folder name plus a relative path and supports batched replace/create/delete operations. run_command accepts workspaceFolder with one of the exact folder names above and then resolves cwd inside that folder.', 'Do not inspect or modify paths outside these listed folders. A task can legitimately change more than one opened folder; Convergent fingerprints and reviews the combined workspace state.'].join('\n');
}
function findWorkspaceFolder(primary, folders, selector) { const roots = normalizeWorkspaceFolders(primary, folders); if (selector === undefined || selector === null || String(selector).trim() === '') return roots[0]; const text = String(selector).trim(); return roots.find((root) => root.name === text) ?? roots.filter((root) => root.name.toLowerCase() === text.toLowerCase()).filter((_, i, arr) => arr.length === 1)[0] ?? null; }
function isWithinRoot(root, candidate) { if (!candidate) return false; const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function rootForPath(primary, folders, candidate) { const resolved = path.resolve(candidate); return normalizeWorkspaceFolders(primary, folders).filter((root) => isWithinRoot(root.path, resolved)).sort((a, b) => b.path.length - a.path.length)[0] ?? null; }
function qualifiedWorkspacePath(primary, folders, root, relative) { const roots = normalizeWorkspaceFolders(primary, folders); const normalized = String(relative ?? '').replace(/\\/g, '/'); return roots.length > 1 ? `${root.name}::${normalized}` : normalized; }
function parseQualifiedWorkspacePath(primary, folders, value) { const roots = normalizeWorkspaceFolders(primary, folders); const text = String(value ?? '').trim(); const marker = text.indexOf('::'); if (marker <= 0) return { root: roots[0], relative: text, qualified: false }; const root = findWorkspaceFolder(primary, roots, text.slice(0, marker)); return { root, relative: text.slice(marker + 2), qualified: true }; }
module.exports = { normalizeWorkspaceFolders, workspaceScopePrompt, findWorkspaceFolder, isWithinRoot, rootForPath, qualifiedWorkspacePath, parseQualifiedWorkspacePath };
