'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunCommandTool } = require('../src/copilot/run-command-tool');

test('run_command prefers frontend-neutral ui.audit lifecycle sink', async () => {
  let tool;
  const events = [];
  createRunCommandTool((name, config) => { tool = { name, ...config }; return tool; }, {
    runtime: {
      async execute(owner, options) {
        options.onStart({ commandId: 'cmd-ui', pid: 77, cwd: '/repo', startedAt: Date.now() });
        options.onOutput({ commandId: 'cmd-ui', pid: 77, stream: 'stdout', chunk: 'ok', bytes: 2, elapsedMs: 2 });
        return {
          commandId: 'cmd-ui', pid: 77, state: 'completed', exitCode: 0, signal: null,
          elapsedMs: 3, stdout: 'ok', stderr: '', stdoutTruncated: false, stderrTruncated: false, termination: null,
        };
      },
    },
    workspace: '/repo',
    owner: 'Worker A',
    permissionHandler: async () => ({ kind: 'approve-once' }),
    ui: {
      audit(event) { events.push(event); },
      auditEvent() { throw new Error('auditEvent fallback must not be used when audit() exists'); },
      agentManagedCommandComplete(agent, detail) { events.push({ type: 'ui_complete', agent, detail }); },
    },
  });

  const result = await tool.handler({ command: 'node --test' });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(events.map((event) => event.type), [
    'managed_command_start',
    'managed_command_progress',
    'managed_command_complete',
    'ui_complete',
  ]);
  assert.equal(events[1].bytes, 2);
  assert.equal(Object.hasOwn(events[1], 'chunk'), false);
});
