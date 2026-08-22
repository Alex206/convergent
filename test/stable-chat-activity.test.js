'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StableVscodeWorkflowUi } = require('../src/ui/stable-vscode-ui');

function uiFixture() {
  const markdown = [];
  const progress = [];
  const outputLines = [];
  const stream = {
    markdown: (value) => markdown.push(String(value)),
    progress: (value) => progress.push(String(value)),
    anchor() {},
  };
  const output = { appendLine: (value) => outputLines.push(String(value)) };
  const ui = new StableVscodeWorkflowUi({ Uri: { file: (value) => value } }, stream, output, { workspace: '/repo' });
  return { ui, markdown, progress, outputLines };
}

test('stable Chat keeps raw tool activity and intermediate assistant messages in Output only', () => {
  const fixture = uiFixture();
  fixture.ui.agentTool('Worker A', 'rg', 'search pattern foo');
  fixture.ui.agentToolComplete('Worker A', 'rg', 250, true);
  fixture.ui.agentMessage('Worker A', 'I am now opening another implementation file.');
  fixture.ui.agentUsageEvent('Worker A', { hasCreditData: false, inputTokens: 1000, outputTokens: 10, turns: 1, elapsedMs: 100 });

  assert.equal(fixture.markdown.length, 0);
  assert.equal(fixture.progress.length, 0);
  const log = fixture.outputLines.join('\n');
  assert.match(log, /Worker A tool: rg/);
  assert.match(log, /tool complete: rg/);
  assert.match(log, /opening another implementation file/i);
  assert.match(log, /usage checkpoint/i);
});

test('stable Chat still surfaces a failed low-level tool compactly', () => {
  const fixture = uiFixture();
  fixture.ui.agentToolComplete('Explore', 'view', 1200, false);
  assert.equal(fixture.progress.length, 1);
  assert.match(fixture.progress[0], /Explore: view failed/);
});
