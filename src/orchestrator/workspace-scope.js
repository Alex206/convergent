'use strict';
const path = require('node:path');
const REVIEW_CONTRACT_FLAG = 'acceptance-matrix-v1';
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
function benchmarkReviewContractPrompt(env = process.env) {
  if (String(env?.CONVERGENT_BENCHMARK_REVIEW_CONTRACT ?? '') !== REVIEW_CONTRACT_FLAG) return '';
  return [
    'BENCHMARK-ONLY REVIEW QUALITY CONTRACT:',
    'This block applies only when your assigned role is a reviewer or quality gate. Implementers and coordinators should ignore it.',
    'Before returning CLEAN, derive a compact acceptance matrix from every explicit task requirement and verify each criterion against the current implementation. Include type/shape constraints, negative cases, global semantic invariants, diagnostics, compatibility, and other boundary behavior that the task text makes material.',
    'For each criterion, distinguish implementation evidence from validation evidence. The existence of a test is not proof that the test exercises the requirement; challenge fixtures and assertions for the boundary case they are meant to cover.',
    'For type/shape contracts, explicitly distinguish an omitted optional field from an explicitly supplied null/None value when the task requires a concrete type or sequence. Probe representative invalid categories rather than assuming a normalization helper rejects them.',
    'For a global semantic invariant, validate the invariant itself rather than an algorithm name, comment, or one plausible example. Prefer a small bounded property-style probe over one witness when practical. Translate the requirement into a direct predicate and exercise several small structurally distinct inputs. Examples: for relative-order preservation, verify every pair not constrained by the ordering relation retains its original relative order across several small dependency shapes; for containment, try distinct traversal/absolute-path forms; for monotonicity or lifecycle invariants, exercise more than one transition shape.',
    'If a single witness is used for a global invariant, use at least two structurally different witnesses. One must be capable of distinguishing a plausible near-miss implementation from the requested semantics.',
    'Collect all independently discoverable actionable findings in one bounded review sweep. Do not stop after the first obvious omission such as missing tests.',
    'On every remediation review, rebuild and re-check the full acceptance matrix against the complete current diff, not only the previously reported finding.',
    'If remediation changed algorithmic behavior or fixed a correctness finding, independent validation is mandatory before CLEAN. Do not validate only by replaying the witness that caused the finding: use a fresh structurally different witness or rerun the bounded property predicate against the new implementation.',
    'Do not invent hidden requirements. If wording is genuinely ambiguous, judge only reasonable implications of the supplied task and repository contract.',
    'CLEAN is allowed only after every explicit acceptance criterion has implementation evidence and adequate independent validation evidence, or a concrete reason why separate validation is unnecessary.',
  ].join('\n');
}
function workspaceScopePrompt(primary, folders = null) {
  const reviewContract = benchmarkReviewContractPrompt();
  const roots = normalizeWorkspaceFolders(primary, folders); if (roots.length <= 1) return reviewContract;
  const exampleRoot = roots[1] ?? roots[0];
  const workspacePrompt = ['MULTI-ROOT VS CODE WORKSPACE:', `The session working directory is the primary folder ${roots[0].name}: ${roots[0].path}`, 'All of the following opened workspace folders are in Convergent scope and may be inspected or modified when the task requires it:', ...roots.map((root, i) => `- ${i === 0 ? 'primary ' : ''}${root.name}: ${root.path}`), `IMPORTANT multi-root path syntax: batch_view folder-qualified paths use the exact form <workspaceFolder>::<relative/path> with a double colon. Example: ${exampleRoot.name}::README.md. Do not use ${exampleRoot.name}/README.md to address another workspace root; that is interpreted relative to the primary folder. batch_view searches every listed folder when using queries/globs, and its returned paths are already qualified for reuse.`, 'Relative built-in file-tool paths resolve from the primary folder. For non-primary files, prefer the exact folder-qualified path returned by batch_view or an absolute path inside that opened folder. Modifying workers should keep native edit/create/apply_patch tools for the primary folder and use workspace_edit for writes in another opened folder. workspace_edit accepts the exact workspace-folder name plus a relative path and supports batched replace/create/delete operations.', `run_command defaults to the primary folder. When a command belongs to another opened root, set workspaceFolder explicitly to that exact folder name (for example ${exampleRoot.name}) instead of probing the primary cwd to locate sibling repositories; cwd is then resolved only inside that selected folder.`, 'Do not inspect or modify paths outside these listed folders. A task can legitimately change more than one opened folder; Convergent fingerprints and reviews the combined workspace state.'].join('\n');
  return [reviewContract, workspacePrompt].filter(Boolean).join('\n\n');
}
function findWorkspaceFolder(primary, folders, selector) { const roots = normalizeWorkspaceFolders(primary, folders); if (selector === undefined || selector === null || String(selector).trim() === '') return roots[0]; const text = String(selector).trim(); return roots.find((root) => root.name === text) ?? roots.filter((root) => root.name.toLowerCase() === text.toLowerCase()).filter((_, i, arr) => arr.length === 1)[0] ?? null; }
function isWithinRoot(root, candidate) { if (!candidate) return false; const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function rootForPath(primary, folders, candidate) { const resolved = path.resolve(candidate); return normalizeWorkspaceFolders(primary, folders).filter((root) => isWithinRoot(root.path, resolved)).sort((a, b) => b.path.length - a.path.length)[0] ?? null; }
function qualifiedWorkspacePath(primary, folders, root, relative) { const roots = normalizeWorkspaceFolders(primary, folders); const normalized = String(relative ?? '').replace(/\\/g, '/'); return roots.length > 1 ? `${root.name}::${normalized}` : normalized; }
function parseQualifiedWorkspacePath(primary, folders, value) { const roots = normalizeWorkspaceFolders(primary, folders); const text = String(value ?? '').trim(); const marker = text.indexOf('::'); if (marker <= 0) return { root: roots[0], relative: text, qualified: false }; const root = findWorkspaceFolder(primary, roots, text.slice(0, marker)); return { root, relative: text.slice(marker + 2), qualified: true }; }
module.exports = { REVIEW_CONTRACT_FLAG, benchmarkReviewContractPrompt, normalizeWorkspaceFolders, workspaceScopePrompt, findWorkspaceFolder, isWithinRoot, rootForPath, qualifiedWorkspacePath, parseQualifiedWorkspacePath };
