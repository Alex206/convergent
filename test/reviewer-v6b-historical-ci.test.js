'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateCase } = require('../src/headless/reviewer-v6b-case-validation');
const { matchesDefect } = require('../src/headless/reviewer-v6b-report');

function workspaceWithValidationStep({ continueOnError }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convergent-v6b-'));
  const dir = path.join(root, '.github', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ci.yml'), `jobs:\n  test:\n    steps:\n      - name: Independently validate benchmark target\n        if: always() && steps.headless-benchmark.outputs.enabled == 'true'\n${continueOnError ? '        continue-on-error: true\\n' : ''}        shell: bash\n        run: |\n          set -o pipefail\n          python3 -B -m unittest discover -s tests -v | tee target-validation.log\n          node src/headless/scenario03-acceptance.js target acceptance.json\n      - name: Upload headless benchmark evidence\n        if: always() && steps.headless-benchmark.outputs.enabled == 'true'\n        uses: actions/upload-artifact@v4\n        with:\n          path: output\n`, 'utf8');
  return root;
}

test('V6B oracle distinguishes PR23 defective and fixed CI gate semantics', () => {
  const defective = workspaceWithValidationStep({ continueOnError: true });
  const fixed = workspaceWithValidationStep({ continueOnError: false });
  try {
    assert.equal(validateCase('v6b-h23-ci-oracle-gate-regression', defective).valid, true);
    assert.equal(validateCase('v6b-h23-ci-oracle-gate-fixed', fixed).valid, true);
    assert.equal(validateCase('v6b-h23-ci-oracle-gate-fixed', defective).valid, false);
  } finally {
    fs.rmSync(defective, { recursive: true, force: true });
    fs.rmSync(fixed, { recursive: true, force: true });
  }
});

test('V6B report matcher recognizes the historical swallowed-oracle failure mechanism', () => {
  assert.equal(matchesDefect('oracle_failure_not_propagated', {
    title: 'Independent oracle can fail while job stays green',
    file: '.github/workflows/ci.yml',
    description: 'continue-on-error: true swallows the non-zero deterministic acceptance failure instead of propagating it to the GitHub job.',
  }), true);
  assert.equal(matchesDefect('oracle_failure_not_propagated', {
    title: 'Artifact retention could be clearer',
    description: 'Consider renaming the upload step.',
  }), false);
});
