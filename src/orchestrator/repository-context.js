'use strict';

const { spawnSync } = require('node:child_process');

function stripGitSuffix(value) {
  return String(value ?? '').replace(/\.git$/i, '');
}

function parseGitRemoteUrl(value) {
  const remoteUrl = String(value ?? '').trim();
  if (!remoteUrl) return null;

  let host = '';
  let pathname = '';
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remoteUrl)) {
      const parsed = new URL(remoteUrl);
      host = parsed.hostname;
      pathname = parsed.pathname;
    } else {
      const scp = remoteUrl.match(/^(?:[^@\s]+@)?([^:\s/]+):(.+)$/);
      if (!scp) return null;
      host = scp[1];
      pathname = scp[2];
    }
  } catch {
    return null;
  }

  const segments = stripGitSuffix(pathname)
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  if (!host || segments.length < 2) return null;
  const repo = segments.at(-1);
  const owner = segments.at(-2);
  return {
    remoteUrl,
    host: host.toLowerCase(),
    owner,
    repo,
    slug: `${owner}/${repo}`,
  };
}

function repositoryContextForDirectorySync(cwd, { spawn = spawnSync } = {}) {
  if (!cwd) return null;
  let result;
  try {
    result = spawn('git', ['-C', String(cwd), 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  if (result?.error || Number(result?.status) !== 0) return null;
  return parseGitRemoteUrl(result?.stdout);
}

function commandUsesGhCli(command) {
  return /(^|[\s;&|()])gh(?:\.exe)?\s+/i.test(String(command ?? ''));
}

function commandSetsGhHost(command) {
  const text = String(command ?? '');
  return /(?:^|[\s;&|])GH_HOST\s*=/i.test(text)
    || /\$env:GH_HOST\s*=/i.test(text)
    || /\benv\s+[^\n;]*\bGH_HOST\s*=/i.test(text);
}

function shellSingleQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function withRepositoryGhHost(command, context, platform = process.platform) {
  const text = String(command ?? '');
  const host = String(context?.host ?? '').trim();
  if (!host || !commandUsesGhCli(text) || commandSetsGhHost(text)) return text;
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return text;
  if (platform === 'win32') return `$env:GH_HOST=${shellSingleQuote(host)}; ${text}`;
  return `export GH_HOST=${shellSingleQuote(host)}; ${text}`;
}

function formatRepositoryContextPrompt(entries = []) {
  const contexts = entries.filter((entry) => entry?.context?.host && entry?.context?.slug);
  if (!contexts.length) return '';
  return [
    'GITHUB REPOSITORY CONTEXT (deterministic from each workspace root origin remote):',
    ...contexts.map(({ name, context }) => `- ${name}: ${context.host}/${context.slug}`),
    'For GitHub CLI commands, use the host belonging to the selected workspace root. Convergent run_command seeds GH_HOST from that origin automatically when the command does not set GH_HOST itself. For builtin shell tools, set GH_HOST explicitly or use a full issue/PR URL; do not assume github.com and do not invent unsupported subcommand --hostname flags. When intentionally querying a different GitHub host, set GH_HOST explicitly for that command.',
  ].join('\n');
}

module.exports = {
  parseGitRemoteUrl,
  repositoryContextForDirectorySync,
  commandUsesGhCli,
  commandSetsGhHost,
  withRepositoryGhHost,
  formatRepositoryContextPrompt,
};
