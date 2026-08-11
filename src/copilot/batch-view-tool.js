'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isWithin } = require('./permissions');

const MAX_BATCH_VIEW_PATHS = 12;
const MAX_BATCH_VIEW_CHARS_PER_FILE = 12 * 1024;
const MAX_BATCH_VIEW_TOTAL_CHARS = 48 * 1024;
const READ_BYTES_PER_FILE = MAX_BATCH_VIEW_CHARS_PER_FILE * 4;

function relativePathAllowed(value) {
  const text = String(value ?? '').trim();
  if (!text || path.isAbsolute(text)) return false;
  const normalized = text.replace(/\\/g, '/');
  if (normalized === '.git' || normalized.startsWith('.git/')) return false;
  const parts = normalized.split('/').filter(Boolean);
  return !parts.includes('..');
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

function createBatchViewTool(defineTool, workspace) {
  const root = path.resolve(workspace);
  return defineTool('batch_view', {
    description: `Read up to ${MAX_BATCH_VIEW_PATHS} known repository-relative text files in one bounded read-only tool call. Prefer this over serial builtin:view calls when several relevant files are already known. Paths must exist inside the current workspace and may not address .git.`,
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_BATCH_VIEW_PATHS,
          items: { type: 'string' },
          description: 'Repository-relative paths to existing text files, in the order their content should be returned.',
        },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args = {}) => {
      const requested = Array.isArray(args.paths) ? args.paths.slice(0, MAX_BATCH_VIEW_PATHS) : [];
      if (!requested.length) {
        return { files: [], error: 'paths must contain at least one repository-relative file path' };
      }

      let rootReal;
      try {
        rootReal = await fs.realpath(root);
      } catch (error) {
        return { files: [], error: `workspace_unavailable: ${error?.message ?? String(error)}` };
      }

      const loaded = await Promise.all(requested.map(async (rawPath) => {
        const requestedPath = String(rawPath ?? '').trim();
        if (!relativePathAllowed(requestedPath)) {
          return { path: requestedPath, ok: false, error: 'invalid_path' };
        }

        const target = path.resolve(root, requestedPath);
        if (!isWithin(root, target)) {
          return { path: requestedPath, ok: false, error: 'outside_workspace' };
        }

        let targetReal;
        try {
          targetReal = await fs.realpath(target);
        } catch (error) {
          return { path: requestedPath, ok: false, error: errorCode(error) };
        }
        if (!isWithin(rootReal, targetReal)) {
          return { path: requestedPath, ok: false, error: 'outside_workspace' };
        }

        try {
          const result = await readBoundedFile(targetReal);
          return {
            path: requestedPath.replace(/\\/g, '/'),
            ok: true,
            ...result,
          };
        } catch (error) {
          return { path: requestedPath.replace(/\\/g, '/'), ok: false, error: errorCode(error) };
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

      return {
        files,
        limits: {
          maxPaths: MAX_BATCH_VIEW_PATHS,
          maxCharsPerFile: MAX_BATCH_VIEW_CHARS_PER_FILE,
          maxTotalChars: MAX_BATCH_VIEW_TOTAL_CHARS,
        },
        totalChars: MAX_BATCH_VIEW_TOTAL_CHARS - remaining,
      };
    },
  });
}

module.exports = {
  createBatchViewTool,
  relativePathAllowed,
  readBoundedFile,
  MAX_BATCH_VIEW_PATHS,
  MAX_BATCH_VIEW_CHARS_PER_FILE,
  MAX_BATCH_VIEW_TOTAL_CHARS,
};
