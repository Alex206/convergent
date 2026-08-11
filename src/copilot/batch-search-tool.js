'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const MAX_BATCH_SEARCH_QUERIES = 8;
const MAX_BATCH_SEARCH_GLOBS = 8;
const MAX_BATCH_SEARCH_MATCHES = 20;
const MAX_BATCH_SEARCH_PATHS = 40;
const MAX_BATCH_SEARCH_TOTAL_CHARS = 48 * 1024;

function boundedStrings(value, maxItems) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const raw of value) {
    const text = String(raw ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function globToRegExp(glob) {
  const source = String(glob ?? '').replace(/\\/g, '/');
  let regex = '^';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '*') {
      if (source[index + 1] === '*') {
        index += 1;
        if (source[index + 1] === '/') {
          index += 1;
          regex += '(?:.*/)?';
        } else {
          regex += '.*';
        }
      } else {
        regex += '[^/]*';
      }
    } else if (char === '?') {
      regex += '[^/]';
    } else {
      regex += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  regex += '$';
  return new RegExp(regex);
}

function parseGrepLine(line) {
  const match = /^(.+?):(\d+):(.*)$/.exec(String(line ?? ''));
  if (!match) return null;
  return {
    path: match[1].replace(/\\/g, '/'),
    line: Number(match[2]),
    text: match[3].trimEnd(),
  };
}

async function gitTextSearch(root, pattern) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'grep', '-n', '-I', '-F', '-e', pattern, '--', '.'],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout.split(/\r?\n/).filter(Boolean).map(parseGrepLine).filter(Boolean);
  } catch (error) {
    if (error?.code === 1) return [];
    throw error;
  }
}

async function gitTrackedFiles(root) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', root, 'ls-files', '-z'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout.split('\0').filter(Boolean).map((file) => file.replace(/\\/g, '/'));
}

function trimResultToBudget(result, budget) {
  const serialized = JSON.stringify(result);
  if (serialized.length <= budget) return { result, used: serialized.length };
  if (Array.isArray(result.matches)) {
    const matches = [];
    let used = JSON.stringify({ ...result, matches }).length;
    for (const match of result.matches) {
      const cost = JSON.stringify(match).length + 1;
      if (used + cost > budget) break;
      matches.push(match);
      used += cost;
    }
    return { result: { ...result, matches, truncated: true }, used };
  }
  if (Array.isArray(result.paths)) {
    const paths = [];
    let used = JSON.stringify({ ...result, paths }).length;
    for (const file of result.paths) {
      const cost = JSON.stringify(file).length + 1;
      if (used + cost > budget) break;
      paths.push(file);
      used += cost;
    }
    return { result: { ...result, paths, truncated: true }, used };
  }
  return { result, used: Math.min(serialized.length, budget) };
}

function createBatchSearchTool(defineTool, workspace) {
  const root = path.resolve(workspace);
  return defineTool('batch_search', {
    description: `Locate several known symbols/literals and tracked-file glob patterns in one bounded read-only repository search. Use this instead of serial grep/rg/glob calls when planning or reviewing multiple known questions. Up to ${MAX_BATCH_SEARCH_QUERIES} literal searches and ${MAX_BATCH_SEARCH_GLOBS} file globs can be submitted together.`,
    parameters: {
      type: 'object',
      properties: {
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
      },
      additionalProperties: false,
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args = {}) => {
      const queries = boundedStrings(args.queries, MAX_BATCH_SEARCH_QUERIES);
      const globs = boundedStrings(args.globs, MAX_BATCH_SEARCH_GLOBS);
      if (!queries.length && !globs.length) {
        return { searches: [], globs: [], error: 'provide at least one literal query or tracked-file glob' };
      }

      const [searchResults, tracked] = await Promise.all([
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

      let remaining = MAX_BATCH_SEARCH_TOTAL_CHARS;
      const searches = searchResults.map((entry) => {
        const trimmed = trimResultToBudget(entry, Math.max(0, remaining));
        remaining -= trimmed.used;
        return trimmed.result;
      });
      const boundedGlobs = globResults.map((entry) => {
        const trimmed = trimResultToBudget(entry, Math.max(0, remaining));
        remaining -= trimmed.used;
        return trimmed.result;
      });

      return {
        searches,
        globs: boundedGlobs,
        limits: {
          maxQueries: MAX_BATCH_SEARCH_QUERIES,
          maxGlobs: MAX_BATCH_SEARCH_GLOBS,
          maxMatchesPerQuery: MAX_BATCH_SEARCH_MATCHES,
          maxPathsPerGlob: MAX_BATCH_SEARCH_PATHS,
          maxTotalChars: MAX_BATCH_SEARCH_TOTAL_CHARS,
        },
        truncated: remaining <= 0,
      };
    },
  });
}

module.exports = {
  createBatchSearchTool,
  boundedStrings,
  globToRegExp,
  parseGrepLine,
  gitTextSearch,
  gitTrackedFiles,
  MAX_BATCH_SEARCH_QUERIES,
  MAX_BATCH_SEARCH_GLOBS,
  MAX_BATCH_SEARCH_MATCHES,
  MAX_BATCH_SEARCH_PATHS,
  MAX_BATCH_SEARCH_TOTAL_CHARS,
};
