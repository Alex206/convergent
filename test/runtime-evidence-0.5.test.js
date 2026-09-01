'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseGitRemoteUrl,
  commandUsesGhCli,
  commandSetsGhHost,
  withRepositoryGhHost,
  formatRepositoryContextPrompt,
} = require('../src/orchestrator/repository-context');
const { SessionGuard } = require('../src/copilot/session-guard-0.5');
const { createRunCommandTool } = require('../src/copilot/run-command-tool-0.5');
const { formatTaskChangeManifest, reviewEvidencePacketId } = require('../src/orchestrator/task-change-manifest-0.5');

function fakeSession() {
  const handlers = new Map();
  return {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => handlers.set(name, (handlers.get(name) ?? []).filter((item) => item !== handler));
    },
    emit(name, data) {
      for (const handler of handlers.get(name) ?? []) handler({ data });
    },
    send: async () => {},
    sendAndWait: async () => {},
    abort: async () => {},
    disconnect: async () => {},
  };
}

test('repository context parses enterprise HTTPS and SSH remotes', () => {
  assert.deepEqual(parseGitRemoteUrl('https://vwg.ghe.com/eps-pmt/cicd_workflows.git'), {
    remoteUrl: 'https://vwg.ghe.com/eps-pmt/cicd_workflows.git',
    host: 'vwg.ghe.com',
    owner: 'eps-pmt',
    repo: 'cicd_workflows',
    slug: 'eps-pmt/cicd_workflows',
  });
  assert.equal(parseGitRemoteUrl('git@git.hub.vwgroup.com:eps-pmt/cicd_workflows.git').host, 'git.hub.vwgroup.com');
  assert.equal(parseGitRemoteUrl('git@git.hub.vwgroup.com:eps-pmt/cicd_workflows.git').slug, 'eps-pmt/cicd_workflows');
});

test('GitHub host binding only affects gh commands without an explicit host', () => {
  const context = { host: 'vwg.ghe.com', slug: 'eps-pmt/cicd_workflows' };
  assert.equal(commandUsesGhCli('gh issue view 3'), true);
  assert.equal(commandUsesGhCli('echo gh issue view 3'), false);
  assert.equal(commandSetsGhHost("$env:GH_HOST='github.com'; gh api repos/openai/openai"), true);
  assert.match(withRepositoryGhHost('gh issue view 3', context, 'win32'), /^\$env:GH_HOST='vwg\.ghe\.com'; gh issue view 3$/);
  assert.match(withRepositoryGhHost('gh issue view 3', context, 'linux'), /^export GH_HOST='vwg\.ghe\.com'; gh issue view 3$/);
  const explicit = "$env:GH_HOST='github.com'; gh api repos/openai/openai";
  assert.equal(withRepositoryGhHost(explicit, context, 'win32'), explicit);
  assert.match(formatRepositoryContextPrompt([{ name: 'cicd_workflows', context }]), /vwg\.ghe\.com\/eps-pmt\/cicd_workflows/);
});

test('0.5 session guard correlates concurrent tool completion by toolCallId', () => {
  const session = fakeSession();
  const completions = [];
  const guard = new SessionGuard(session, 'Worker A', {
    agentToolComplete: (agent, name, durationMs, success) => completions.push({ agent, name, success }),
  }, { heartbeatMs: 60_000 });

  session.emit('tool.execution_start', { toolCallId: 'cmd-tool', toolName: 'run_command', arguments: { command: 'gh auth status' } });
  session.emit('tool.execution_start', { toolCallId: 'view-tool', toolName: 'batch_view', arguments: { paths: ['README.md'] } });
  assert.equal(guard.snapshot().activeTools.length, 2);

  // Reproduce the observed log ordering: the second tool succeeds before the
  // managed command finishes with a failure. Each completion must retain its
  // own tool identity and success bit.
  session.emit('tool.execution_complete', { toolCallId: 'view-tool', toolName: 'batch_view', success: true });
  session.emit('tool.execution_complete', { toolCallId: 'cmd-tool', toolName: 'run_command', success: false });

  assert.deepEqual(completions.map(({ name, success }) => ({ name, success })), [
    { name: 'batch_view', success: true },
    { name: 'run_command', success: false },
  ]);
  const snapshot = guard.snapshot();
  assert.equal(snapshot.currentTool, null);
  assert.equal(snapshot.activeTools.length, 0);
  assert.equal(snapshot.tools.find((tool) => tool.name === 'run_command').failures, 1);
  assert.equal(snapshot.tools.find((tool) => tool.name === 'batch_view').failures, 0);
});

test('0.5 run_command seeds GH_HOST from selected repository context after permission approval', async () => {
  let definition;
  let executed;
  const audits = [];
  const runtime = {
    async execute(owner, options) {
      executed = { owner, options };
      return {
        commandId: 'cmd-1', pid: 42, state: 'completed', exitCode: 0, signal: null,
        elapsedMs: 1, stdout: '{}', stderr: '', stdoutTruncated: false, stderrTruncated: false, termination: null,
      };
    },
  };
  createRunCommandTool((name, config) => { definition = { name, ...config }; return definition; }, {
    runtime,
    workspace: process.cwd(),
    owner: 'Worker A',
    ui: { auditEvent: (event) => audits.push(event) },
    permissionHandler: async () => ({ kind: 'approve-once' }),
    repositoryContextProvider: () => ({ host: 'vwg.ghe.com', slug: 'eps-pmt/cicd_workflows' }),
  });

  await definition.handler({ command: 'gh issue view 3 --repo eps-pmt/cicd_workflows' });
  assert.equal(executed.owner, 'Worker A');
  assert.match(executed.options.command, /GH_HOST/);
  assert.match(executed.options.command, /vwg\.ghe\.com/);
  assert.match(executed.options.command, /gh issue view 3 --repo eps-pmt\/cicd_workflows/);
  assert.match(definition.description, /derives GH_HOST/i);
  assert.equal(audits.some((event) => event.type === 'managed_command_github_host_context'), true);
});

test('review manifest is promoted to one shared deterministic evidence packet', () => {
  const manifest = {
    baselineHead: 'abc',
    currentHead: 'def',
    count: 1,
    entries: [{
      path: 'src/example.js',
      status: 'M',
      kind: 'changed_since_task_start',
      reviewDiff: 'diff --git a/src/example.js b/src/example.js\n-old\n+new',
    }],
  };
  const id = reviewEvidencePacketId(manifest);
  const review = formatTaskChangeManifest(manifest, 'Deterministic task change manifest for this review');
  assert.match(review, new RegExp(`SHARED DETERMINISTIC REVIEW EVIDENCE PACKET ${id}`));
  assert.match(review, /independent reasoning over shared evidence/i);
  assert.match(review, /Do not run git status\/diff/i);
  assert.match(review, /src\/example\.js/);

  const ordinary = formatTaskChangeManifest(manifest, 'Task change manifest after worker pass');
  assert.doesNotMatch(ordinary, /SHARED DETERMINISTIC REVIEW EVIDENCE PACKET/);
});
