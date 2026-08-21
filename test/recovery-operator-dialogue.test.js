'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RecoveryConvergentEngine,
  operatorAgreementQuestion,
  operatorDialoguePrompt,
} = require('../src/orchestrator/recovery-engine');

const task = {
  id: 'broker-contract',
  title: 'Complete broker integration',
  description: 'Complete the governed broker integration without inventing an external service contract.',
  acceptanceCriteria: ['The recovery path is agreed with the operator before implementation continues.'],
};

function createDialogueEngine(reports, answers, options = {}) {
  const sink = { value: null };
  const prompts = [];
  const questions = [];
  const audits = [];
  const session = {
    sessionId: 'recovery-dialogue',
    async sendAndWait(request) {
      prompts.push(request.prompt);
      sink.value = reports.shift();
    },
    async disconnect() {},
  };
  const engine = new RecoveryConvergentEngine({
    client: {},
    sdk: {},
    workspace: '/repo',
    models: {},
    maxOperatorDialogueRounds: options.maxOperatorDialogueRounds,
    ui: {
      phase() {},
      log() {},
      audit(event) { audits.push(event); },
    },
    userInputHandler: async ({ question }) => {
      questions.push(question);
      return { answer: answers.shift() };
    },
  });
  engine.recoveryFactory = () => ({
    createRecoveryCoordinator: async () => ({ session, sink, name: 'Recovery coordinator' }),
  });
  return { engine, prompts, questions, audits };
}

test('operator recovery supports explanation, follow-up, and explicit confirmation before retry', async () => {
  const reports = [
    { action: 'ask_user', rationale: 'Need the intended boundary.', question: 'What downstream contract should be used?', guidance: '' },
    { action: 'ask_user', rationale: 'Operator asked why.', question: 'The task mentions downstream rejection handling, but no downstream API exists. Should the acceptance criterion be satisfied at the existing policy boundary instead?', guidance: '' },
    { action: 'retry', rationale: 'Use the existing policy boundary and do not invent an endpoint.', question: '', guidance: 'Keep rejection handling at the existing policy boundary; do not invent a downstream API.' },
    { action: 'retry', rationale: 'Operator confirmed the policy-boundary interpretation.', question: '', guidance: 'Operator confirmed: keep rejection handling at the existing policy boundary and do not invent a downstream API.' },
  ];
  const answers = [
    'I do not understand why you need an endpoint. Explain that first.',
    'There is no endpoint. Yes, the existing policy boundary is what I mean.',
    'Yes, that is correct. Continue with that interpretation.',
  ];
  const { engine, prompts, questions, audits } = createDialogueEngine(reports, answers);

  const decision = await engine.consultRecoveryCoordinator(task, 'worker-A', {
    changed: true,
    workspaceFingerprint: 'R1',
    summary: 'Implementation is complete except for an external downstream contract that is absent.',
    findings: ['No downstream endpoint/request schema exists in the opened repositories.'],
    checks: ['Focused policy tests pass.'],
  }, { allowPeer: true });

  assert.equal(decision.action, 'retry');
  assert.equal(questions.length, 3);
  assert.match(questions[0], /Blocked report context:/);
  assert.match(questions[1], /policy boundary/i);
  assert.match(questions[2], /Before Convergent continues/i);
  assert.match(questions[2], /confirm/i);
  assert.match(prompts[1], /Continue the discussion/i);
  assert.match(prompts[3], /Operator reply to the confirmation request/i);
  assert.match(decision.guidance, /Operator confirmed/i);
  assert.doesNotMatch(decision.guidance, /I do not understand why you need an endpoint/i);
  const audit = audits.find((event) => event.type === 'recovery_decision');
  assert.equal(audit.operatorContextProvided, true);
  assert.equal(audit.operatorDialogueRounds, 3);
  assert.equal(engine.operatorRecoveryHistory.get('broker-contract\0worker')?.consumed, true);
});

test('operator correction at confirmation returns to discussion instead of continuing', async () => {
  const reports = [
    { action: 'ask_user', rationale: 'Need scope.', question: 'Should the worker retry?', guidance: '' },
    { action: 'retry', rationale: 'Retry with the preserved workspace.', question: '', guidance: 'Retry unchanged.' },
    { action: 'ask_user', rationale: 'Operator rejected the proposal.', question: 'Understood. Do you want Convergent to pause this task instead?', guidance: '' },
    { action: 'pause', rationale: 'Operator wants the task paused rather than retried.', question: '', guidance: 'Do not retry until the operator supplies a different direction.' },
  ];
  const answers = [
    'Maybe, but tell me exactly what retry means.',
    'No. I do not agree with retrying. I want to discuss or pause it.',
    'Pause it.',
  ];
  const { engine, questions } = createDialogueEngine(reports, answers);

  const decision = await engine.consultRecoveryCoordinator(task, 'worker-A', {
    workspaceFingerprint: 'R2',
    summary: 'Worker is blocked.',
  }, { allowPeer: true });

  assert.equal(decision.action, 'pause');
  assert.equal(questions.length, 3);
  assert.match(questions[1], /Before Convergent continues/i);
  assert.match(questions[2], /pause/i);
  assert.equal(engine.operatorRecoveryHistory.has('broker-contract\0worker'), false);
});

test('operator dialogue pauses rather than guessing when the bounded discussion does not converge', async () => {
  const reports = [
    { action: 'ask_user', rationale: 'Need clarification.', question: 'Which option?', guidance: '' },
    { action: 'ask_user', rationale: 'Still unclear.', question: 'Can you clarify the intended behavior?', guidance: '' },
    { action: 'ask_user', rationale: 'Still unclear.', question: 'One more clarification?', guidance: '' },
  ];
  const answers = ['I am not sure yet.', 'I still need an explanation.'];
  const { engine, questions } = createDialogueEngine(reports, answers, { maxOperatorDialogueRounds: 2 });

  const decision = await engine.consultRecoveryCoordinator(task, 'worker-A', {
    workspaceFingerprint: 'R3',
    summary: 'Worker is blocked on an unresolved operator decision.',
  }, { allowPeer: true });

  assert.equal(decision.action, 'pause');
  assert.equal(questions.length, 2);
  assert.match(decision.rationale, /did not reach a clear agreement/i);
});

test('agreement and dialogue prompts make the no-silent-continuation contract explicit', () => {
  const agreement = operatorAgreementQuestion({ action: 'peer', rationale: 'Independent check is useful.', guidance: 'Check the existing contract only.' });
  assert.match(agreement, /will not continue until/i);
  assert.match(agreement, /correction or question/i);

  const dialogue = operatorDialoguePrompt('Why is this required?', { allowPeer: true });
  assert.match(dialogue, /real conversation|Continue the discussion/i);
  assert.match(dialogue, /asks a question/i);
  assert.match(dialogue, /explicit confirmation/i);
});
