'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const path = require('node:path');
const { REVIEW_CONTRACT_FLAG, benchmarkReviewContractPrompt, normalizeWorkspaceFolders, workspaceScopePrompt, parseQualifiedWorkspacePath } = require('../src/orchestrator/workspace-scope');
test('workspace scope keeps primary and all roots', () => { const a = path.resolve('/tmp/repo-a'); const b = path.resolve('/tmp/repo-b'); const roots = normalizeWorkspaceFolders(b, [{ name: 'repo-a', path: a }, { name: 'repo-b', path: b }]); assert.equal(roots[0].path, b); assert.deepEqual(new Set(roots.map((root) => root.path)), new Set([a, b])); const prompt = workspaceScopePrompt(b, roots); assert.match(prompt, /repo-a/); assert.match(prompt, /<workspaceFolder>::<relative\/path>/); assert.match(prompt, /repo-a::README\.md/); assert.match(prompt, /run_command defaults to the primary folder/i); assert.match(prompt, /set workspaceFolder explicitly/i); const parsed = parseQualifiedWorkspacePath(b, roots, 'repo-a::src/a.js'); assert.equal(parsed.root.path, a); assert.equal(parsed.relative, 'src/a.js'); });

test('nested roots resolve to the most specific opened folder', () => { const parent = path.resolve('/tmp/repo'); const child = path.join(parent, 'child'); const { rootForPath } = require('../src/orchestrator/workspace-scope'); const root = rootForPath(parent, [{ name: 'parent', path: parent }, { name: 'child', path: child }], path.join(child, 'x.txt')); assert.equal(root.name, 'child'); });

test('benchmark review contract is opt-in and requires full acceptance re-review', () => {
  assert.equal(benchmarkReviewContractPrompt({}), '');
  const prompt = benchmarkReviewContractPrompt({ CONVERGENT_BENCHMARK_REVIEW_CONTRACT: REVIEW_CONTRACT_FLAG });
  assert.match(prompt, /acceptance matrix/i);
  assert.match(prompt, /type\/shape constraints/i);
  assert.match(prompt, /existence of a test is not proof/i);
  assert.match(prompt, /all independently discoverable actionable findings/i);
  assert.match(prompt, /every remediation review/i);
  assert.match(prompt, /full acceptance matrix/i);
  assert.match(prompt, /do not invent hidden requirements/i);
});

test('single-root workspace injects review contract only when benchmark flag is enabled', () => {
  const root = path.resolve('/tmp/repo');
  const old = process.env.CONVERGENT_BENCHMARK_REVIEW_CONTRACT;
  delete process.env.CONVERGENT_BENCHMARK_REVIEW_CONTRACT;
  try {
    assert.equal(workspaceScopePrompt(root), '');
    process.env.CONVERGENT_BENCHMARK_REVIEW_CONTRACT = REVIEW_CONTRACT_FLAG;
    const prompt = workspaceScopePrompt(root);
    assert.match(prompt, /BENCHMARK-ONLY REVIEW QUALITY CONTRACT/);
    assert.match(prompt, /CLEAN is allowed only after every explicit acceptance criterion/i);
  } finally {
    if (old === undefined) delete process.env.CONVERGENT_BENCHMARK_REVIEW_CONTRACT;
    else process.env.CONVERGENT_BENCHMARK_REVIEW_CONTRACT = old;
  }
});
