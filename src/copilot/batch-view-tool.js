'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isWithin } = require('./permissions');
const { normalizeWorkspaceFolders, parseQualifiedWorkspacePath, rootForPath, qualifiedWorkspacePath } = require('../orchestrator/workspace-scope');
const {
  boundedStrings,
  globToRegExp,
  gitTextSearch,
  gitTrackedFiles,
  MAX_BATCH_SEARCH_QUERIES,
  MAX_BATCH_SEARCH_GLOBS,
  MAX_BATCH_SEARCH_MATCHES,
  MAX_BATCH_SEARCH_PATHS,
} = require('./batch-search-tool');

const MAX_BATCH_VIEW_PATHS = 12;
const MAX_BATCH_VIEW_CHARS_PER_FILE = 12 * 1024;
const MAX_BATCH_VIEW_TOTAL_CHARS = 48 * 1024;
const READ_BYTES_PER_FILE = MAX_BATCH_VIEW_CHARS_PER_FILE * 4;

function containsForbiddenRelativePart(value) {
  const normalized = String(value ?? '').replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  if (lower === '.git' || lower.startsWith('.git/')) return true;
  return normalized.split('/').filter(Boolean).includes('..');
}

function relativePathAllowed(value) {
  const text = String(value ?? '').trim();
  if (!text || path.posix.isAbsolute(text) || path.win32.isAbsolute(text)) return false;
  return !containsForbiddenRelativePart(text);
}

function resolveRequestedPath(root, value, workspaceFolders = null) {
  const requested = String(value ?? '').trim(); if (!requested) return { ok: false, path: requested, error: 'invalid_path' };
  const roots = normalizeWorkspaceFolders(root, workspaceFolders); const parsed = parseQualifiedWorkspacePath(root, roots, requested); if (!parsed.root) return { ok: false, path: requested, error: 'unknown_workspace_folder' };
  const source = parsed.relative; const looksAbsolute = path.posix.isAbsolute(source) || path.win32.isAbsolute(source); if (looksAbsolute && !path.isAbsolute(source)) return { ok: false, path: requested, error: 'invalid_path' }; if (!looksAbsolute && containsForbiddenRelativePart(source)) return { ok: false, path: requested, error: 'invalid_path' };
  const target = looksAbsolute ? path.resolve(source) : path.resolve(parsed.root.path, source); const owner = rootForPath(root, roots, target); if (!owner) return { ok: false, path: requested, error: 'outside_workspace' };
  const relative = path.relative(owner.path, target).replace(/\\/g, '/'); if (!relative || containsForbiddenRelativePart(relative)) return { ok: false, path: requested, error: 'invalid_path' };
  return { ok: true, path: qualifiedWorkspacePath(root, roots, owner, relative), relative, target, root: owner };
}

async function readBoundedFile(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      const error = new Error('path is not a regular file');
      error.code = 'NOT_FILE';
      throw error;
    }
    const bytesToRead = Math.min(stat.size, READ_BYTES_PER_FILE);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = bytesToRead
      ? await handle.read(buffer, 0, bytesToRead, 0)
      : { bytesRead: 0 };
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) {
      const error = new Error('binary file is not supported');
      error.code = 'BINARY_FILE';
      throw error;
    }
    const decoded = bytes.toString('utf8');
    const content = decoded.slice(0, MAX_BATCH_VIEW_CHARS_PER_FILE);
    return {
      content,
      sizeBytes: stat.size,
      truncated: stat.size > bytesRead || decoded.length > content.length,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

function errorCode(error) {
  if (error?.code === 'ENOENT') return 'not_found';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'permission_denied';
  if (error?.code === 'NOT_FILE') return 'not_file';
  if (error?.code === 'BINARY_FILE') return 'binary_not_supported';
  return 'read_failed';
}

async function discoverRepository(root, queries, globs) {
  const [searches, tracked] = await Promise.all([
    Promise.all(queries.map(async (query) => ({
      query,
      matches: (await gitTextSearch(root, query)).slice(0, MAX_BATCH_SEARCH_MATCHES),
    }))),
    globs.length ? gitTrackedFiles(root) : Promise.resolve([]),
  ]);
  const globResults = globs.map((glob) => {
    let matcher;
    try {
      matcher = globToRegExp(glob);
    } catch {
      return { glob, paths: [], error: 'invalid_glob' };
    }
    return {
      glob,
      paths: tracked.filter((file) => matcher.test(file)).slice(0, MAX_BATCH_SEARCH_PATHS),
    };
  });
  return { searches, globs: globResults };
}

function discoveredPaths(discovery) {
  const result = [];
  const seen = new Set();
  const add = (value) => {
    const file = String(value ?? '').trim().replace(/\\/g, '/');
    if (!file || seen.has(file)) return;
    seen.add(file);
    result.push(file);
  };
  for (const search of discovery.searches ?? []) {
    for (const match of search.matches ?? []) add(match.path);
  }
  for (const glob of discovery.globs ?? []) {
    for (const file of glob.paths ?? []) add(file);
  }
  return result.slice(0, MAX_BATCH_VIEW_PATHS);
}

function createBatchViewTool(defineTool, workspace, workspaceFolders = null) {
  const root = path.resolve(workspace);
  const roots = normalizeWorkspaceFolders(root, workspaceFolders);
  return defineTool('batch_view', {
    description: `Perform one bounded read-only repository inspection. It can search up to ${MAX_BATCH_SEARCH_QUERIES} literal symbols/texts, list up to ${MAX_BATCH_SEARCH_GLOBS} tracked-file globs, and read up to ${MAX_BATCH_VIEW_PATHS} text files in the SAME tool call. Use readMatches=true to immediately read files found by the searches/globs. Prefer this over serial grep/rg/glob/view calls. Absolute paths are accepted only when they resolve inside the current workspace; .git, outside-workspace paths, symlink escapes, and binary files are denied.`,
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          maxItems: MAX_BATCH_VIEW_PATHS,
          items: { type: 'string' },
          description: 'Existing workspace text files to read, preferably repository-relative.',
        },
        queries: {
          type: 'array',
          maxItems: MAX_BATCH_SEARCH_QUERIES,
          items: { type: 'string' },
          description: 'Literal text/symbol searches to run independently across tracked repository text files.',
        },
        globs: {
          type: 'array',
          maxItems: MAX_BATCH_SEARCH_GLOBS,
          items: { type: 'string' },
          description: 'Repository-relative tracked-file glob patterns, for example taskflow/*.py or tests/test_*.py.',
        },
        readMatches: {
          type: 'boolean',
          description: `When true, also read the unique files found by queries/globs, capped with explicit paths at ${MAX_BATCH_VIEW_PATHS} total files.`,
        },
      },
      additionalProperties: false,
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args = {}) => {
      const explicitPaths = boundedStrings(args.paths, MAX_BATCH_VIEW_PATHS);
      const queries = boundedStrings(args.queries, MAX_BATCH_SEARCH_QUERIES);
      const globs = boundedStrings(args.globs, MAX_BATCH_SEARCH_GLOBS);
      if (!explicitPaths.length && !queries.length && !globs.length) {
        return { files: [], searches: [], globs: [], error: 'provide at least one path, literal query, or tracked-file glob' };
      }

      const rootReals = new Map();
      try { for (const item of roots) rootReals.set(item.path, await fs.realpath(item.path)); } catch (error) { return { files: [], searches: [], globs: [], error: `workspace_unavailable: ${error?.message ?? String(error)}` }; }
      let discovery;
      try {
        const perRoot = await Promise.all(roots.map(async (item) => ({ root: item, discovery: await discoverRepository(item.path, queries, globs) })));
        discovery = { searches: queries.map((query) => ({ query, matches: perRoot.flatMap(({ root: item, discovery: value }) => (value.searches.find((entry) => entry.query === query)?.matches ?? []).map((match) => ({ ...match, path: qualifiedWorkspacePath(root, roots, item, match.path), workspaceFolder: item.name }))).slice(0, MAX_BATCH_SEARCH_MATCHES) })), globs: globs.map((glob) => ({ glob, paths: perRoot.flatMap(({ root: item, discovery: value }) => (value.globs.find((entry) => entry.glob === glob)?.paths ?? []).map((file) => qualifiedWorkspacePath(root, roots, item, file))).slice(0, MAX_BATCH_SEARCH_PATHS) })) };
      } catch (error) { return { files: [], searches: [], globs: [], error: `repository_search_failed: ${error?.message ?? String(error)}` }; }

      const requested = [...explicitPaths];
      if (args.readMatches === true) {
        for (const file of discoveredPaths(discovery)) {
          if (requested.length >= MAX_BATCH_VIEW_PATHS) break;
          if (!requested.includes(file)) requested.push(file);
        }
      }

      const loaded = await Promise.all(requested.map(async (rawPath) => {
        const resolved = resolveRequestedPath(root, rawPath, roots);
        if (!resolved.ok) return { path: resolved.path, ok: false, error: resolved.error };

        let targetReal;
        try {
          targetReal = await fs.realpath(resolved.target);
        } catch (error) {
          return { path: resolved.path, ok: false, error: errorCode(error) };
        }
        const realRoot = rootReals.get(resolved.root.path);
        if (!realRoot || !isWithin(realRoot, targetReal)) {
          return { path: resolved.path, ok: false, error: 'outside_workspace' };
        }

        try {
          const result = await readBoundedFile(targetReal);
          return {
            path: resolved.path,
            ok: true,
            ...result,
          };
        } catch (error) {
          return { path: resolved.path, ok: false, error: errorCode(error) };
        }
      }));

      let remaining = MAX_BATCH_VIEW_TOTAL_CHARS;
      const files = loaded.map((entry) => {
        if (!entry.ok) return entry;
        const content = entry.content.slice(0, Math.max(0, remaining));
        remaining -= content.length;
        return {
          ...entry,
          content,
          truncated: entry.truncated || content.length < entry.content.length,
        };
      });
      const totalChars = MAX_BATCH_VIEW_TOTAL_CHARS - remaining;

      return {
        searches: discovery.searches,
        globs: discovery.globs,
        files,
        limits: {
          maxPaths: MAX_BATCH_VIEW_PATHS,
          maxQueries: MAX_BATCH_SEARCH_QUERIES,
          maxGlobs: MAX_BATCH_SEARCH_GLOBS,
          maxMatchesPerQuery: MAX_BATCH_SEARCH_MATCHES,
          maxPathsPerGlob: MAX_BATCH_SEARCH_PATHS,
          maxCharsPerFile: MAX_BATCH_VIEW_CHARS_PER_FILE,
          maxFileCharsTotal: MAX_BATCH_VIEW_TOTAL_CHARS,
        },
        // Preserve the original field for existing consumers while making its scope explicit.
        totalChars,
        totalFileChars: totalChars,
      };
    },
  });
}

module.exports = {
  createBatchViewTool,
  relativePathAllowed,
  resolveRequestedPath,
  readBoundedFile,
  discoverRepository,
  discoveredPaths,
  MAX_BATCH_VIEW_PATHS,
  MAX_BATCH_VIEW_CHARS_PER_FILE,
  MAX_BATCH_VIEW_TOTAL_CHARS,
};
