#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function findFiles(root, basename, found = []) {
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) findFiles(full, basename, found);
    else if (entry.isFile() && entry.name === basename) found.push(full);
  }
  return found;
}

function infrastructureFailure(result) {
  const error = String(result?.error ?? '');
  if (/you have exceeded your monthly quota/i.test(error)) {
    return {
      category: 'copilot-monthly-quota',
      reason: error,
    };
  }
  return null;
}

function artifactRootForResult(root, resultPath) {
  const relative = path.relative(root, resultPath);
  const [first] = relative.split(path.sep);
  if (!first || first === '..' || path.isAbsolute(relative)) return null;
  return path.join(root, first);
}

function uniqueDestination(root, name) {
  let destination = path.join(root, name);
  if (!fs.existsSync(destination)) return destination;
  let suffix = 2;
  while (fs.existsSync(`${destination}-${suffix}`)) suffix += 1;
  return `${destination}-${suffix}`;
}

function quarantineInfrastructureInvalidRuns(root, invalidRoot) {
  const resolvedRoot = path.resolve(root);
  const resolvedInvalidRoot = path.resolve(invalidRoot);
  if (resolvedInvalidRoot === resolvedRoot || resolvedInvalidRoot.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Infrastructure-invalid output must be outside the scored topology-results root.');
  }

  const invalid = [];
  const artifactRoots = new Set();
  for (const resultPath of findFiles(resolvedRoot, 'result.json')) {
    const result = readJson(resultPath, {});
    const failure = infrastructureFailure(result);
    if (!failure) continue;
    const artifactRoot = artifactRootForResult(resolvedRoot, resultPath);
    if (!artifactRoot || artifactRoots.has(artifactRoot)) continue;
    artifactRoots.add(artifactRoot);
    const meta = readJson(path.join(path.dirname(resultPath), 'benchmark-meta.json'), {});
    invalid.push({
      topology: result.topology ?? meta.topology ?? 'unknown',
      scenario: meta.scenario ?? result.promptFile ?? 'unknown',
      repeat: Number(meta.repeat) || 1,
      status: result.status ?? 'failed',
      category: failure.category,
      reason: failure.reason,
      artifact: path.basename(artifactRoot),
    });
  }

  if (invalid.length) fs.mkdirSync(resolvedInvalidRoot, { recursive: true });
  for (const item of invalid) {
    const source = path.join(resolvedRoot, item.artifact);
    if (!fs.existsSync(source)) continue;
    const destination = uniqueDestination(resolvedInvalidRoot, item.artifact);
    fs.renameSync(source, destination);
    item.quarantinedArtifact = path.basename(destination);
  }

  return invalid;
}

function markdownInvalidRuns(invalid) {
  const lines = [
    '# Infrastructure-invalid topology runs',
    '',
    `Infrastructure-invalid runs: **${invalid.length}**. These runs are excluded from acceptance, cost-per-success, and Pareto scoring.`,
  ];
  if (!invalid.length) return `${lines.join('\n')}\n`;
  lines.push(
    '',
    '| Topology | Scenario | Repeat | Category | Reason |',
    '|---|---|---:|---|---|',
  );
  for (const run of invalid) {
    lines.push(`| ${run.topology} | ${run.scenario} | ${run.repeat} | ${run.category} | ${String(run.reason).replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  const root = path.resolve(argv[0] ?? '.');
  const invalidRoot = path.resolve(argv[1] ?? `${root}-infrastructure-invalid`);
  const jsonOut = path.resolve(argv[2] ?? path.join(path.dirname(root), 'topology-infrastructure-invalid.json'));
  const markdownOut = path.resolve(argv[3] ?? path.join(path.dirname(root), 'topology-infrastructure-invalid.md'));
  const invalid = quarantineInfrastructureInvalidRuns(root, invalidRoot);
  fs.writeFileSync(jsonOut, `${JSON.stringify({ invalidRuns: invalid }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownOut, markdownInvalidRuns(invalid), 'utf8');
  process.stdout.write(markdownInvalidRuns(invalid));
}

if (require.main === module) main();

module.exports = {
  infrastructureFailure,
  quarantineInfrastructureInvalidRuns,
  markdownInvalidRuns,
};
