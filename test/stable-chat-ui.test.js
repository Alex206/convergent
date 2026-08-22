'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OperatorDialogueRequestedError,
  isOperatorDialogueRequestedError,
  createDeferredOperatorInputHandler,
  StableChatRecoveryEngine,
} = require('../src/orchestrator/stable-chat-recovery');
const {
  createInitialOperatorDialogue,
  stateWithOperatorDialogue,
  stateWithOperatorAgreement,
  pendingOperatorDialogue,
  dialogueFollowups,
  stableChatHistory,
} = require('../src/ui/chat-dialogue-state');
const { StableVscodeWorkflowUi } = require('../src/ui/stable-vscode-ui');

function fakeResumeState() {
  return {
    version: 1,
    workspace: '/repo',
    workspaceRoots: ['/repo'],
    request: 'implement behavior',
    status: 'interrupted',
    plan: {
      summary: 'one task',
      tasks: [{
        id: 'T1',
        title: 'Implement behavior',
        description: 'Implement behavior',
        acceptanceCriteria: ['works'],
        route: 'high_risk',
        risk: 'high',
        routingReason: 'test',
      }],
    },
    nextTaskIndex: 0,
    currentTaskIndex: 0,
    startTaskIndex: 0,
    taskState: {
      stage: 'worker_blocked',
      worker: 'A',
      routing: { route: 'high_risk', risk: 'high', peerConvergence: true },
      blockedPass: {
        worker: 'A',
        revision: 'R1',
        report: {
          verdict: 'blocked',
          summary: 'External contract is unclear.',
          findings: ['Missing downstream contract.'],
          checks: ['Repository-backed tests pass.'],
        },
      },
    },
  };
}

test('deferred operator input turns free-form recovery into a stable Chat boundary', async () => {
  const handler = createDeferredOperatorInputHandler();
  await assert.rejects(
    () => handler({ question: 'What contract should be used?' }),
    (error) => isOperatorDialogueRequestedError(error)
      && error instanceof OperatorDialogueRequestedError
      && /contract/i.test(error.question),
  );
});

test('operator dialogue is checkpointed and exposes follow-up prompts', () => {
  const state = fakeResumeState();
  const dialogue = createInitialOperatorDialogue(state, 'Should the existing policy boundary be authoritative?');
  assert.equal(dialogue.kind, 'worker-A');
  assert.equal(dialogue.allowPeer, true);
  assert.equal(dialogue.phase, 'discuss');
  assert.match(dialogue.summary, /External contract/i);

  const saved = stateWithOperatorDialogue(state, dialogue);
  assert.equal(pendingOperatorDialogue(saved).question, dialogue.question);
  assert.ok(dialogueFollowups(dialogue).some((item) => /Explain why/i.test(item.prompt)));
});

test('explicit agreement removes dialogue and becomes one resumable recovery authorization', () => {
  const state = fakeResumeState();
  const dialogue = createInitialOperatorDialogue(state, 'Clarify scope.');
  dialogue.phase = 'confirm';
  dialogue.proposal = { action: 'peer', rationale: 'Independent check', guidance: 'Inspect the existing policy boundary only.' };
  const saved = stateWithOperatorAgreement(stateWithOperatorDialogue(state, dialogue), dialogue, dialogue.proposal);

  assert.equal(pendingOperatorDialogue(saved), null);
  assert.equal(saved.taskState.operatorRecoveryAgreement.action, 'peer');
  assert.match(saved.taskState.operatorRecoveryAgreement.guidance, /policy boundary/i);
  assert.equal(saved.taskState.operatorRecoveryAgreement.consumed, false);
});

test('stable Chat history extracts current-participant user and markdown response text only', () => {
  const history = stableChatHistory([
    { prompt: 'Why is this needed?' },
    { response: [{ value: { value: 'Because acceptance requires an observable rejection.' } }] },
  ]);
  assert.deepEqual(history, [
    { role: 'user', content: 'Why is this needed?' },
    { role: 'assistant', content: 'Because acceptance requires an observable rejection.' },
  ]);
});

test('confirmed recovery agreement bypasses another recovery-model call exactly once', async () => {
  let recoveryCalls = 0;
  const engine = new StableChatRecoveryEngine({
    client: {}, sdk: {}, workspace: '/repo', workspaceFolders: [{ name: 'repo', path: '/repo' }], models: {},
    ui: new Proxy({}, { get: () => () => {} }),
  });
  engine.activeOperatorRecoveryAgreement = {
    action: 'retry',
    rationale: 'Operator confirmed existing boundary.',
    guidance: 'Use the existing boundary; do not create a new API.',
    scopeKey: 'T1\0worker',
    consumed: false,
  };
  engine.recoveryFactory = () => {
    recoveryCalls += 1;
    throw new Error('must not create recovery coordinator');
  };
  const task = { id: 'T1' };
  const decision = await engine.consultRecoveryCoordinator(task, 'worker-A', {}, { allowPeer: true });
  assert.equal(decision.action, 'retry');
  assert.equal(decision.operatorAgreed, true);
  assert.equal(recoveryCalls, 0);
  assert.equal(engine.activeOperatorRecoveryAgreement.consumed, true);
});

test('compact command Chat summary never renders stdout/stderr while Output retains it', () => {
  const markdown = [];
  const outputLines = [];
  const stream = { markdown: (value) => markdown.push(String(value)), progress() {}, anchor() {} };
  const output = { appendLine: (value) => outputLines.push(String(value)) };
  const ui = new StableVscodeWorkflowUi({ Uri: { file: (value) => value } }, stream, output, { workspace: '/repo' });
  ui.agentManagedCommandComplete('Worker A', {
    commandId: 'cmd-1',
    state: 'completed',
    exitCode: 1,
    elapsedMs: 2500,
    displayCommand: 'npm test',
    cwd: '/repo',
    stdout: 'VISIBLE ONLY IN OUTPUT',
    stderr: 'failure detail',
  });

  const chat = markdown.join('\n');
  const log = outputLines.join('\n');
  assert.match(chat, /npm test/);
  assert.doesNotMatch(chat, /VISIBLE ONLY IN OUTPUT/);
  assert.match(chat, /retained in the Convergent Output channel/i);
  assert.match(log, /VISIBLE ONLY IN OUTPUT/);
  assert.match(log, /failure detail/);
});
