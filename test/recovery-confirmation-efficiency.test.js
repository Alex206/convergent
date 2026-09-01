'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXACT_PROPOSAL_CONFIRMATION,
  deterministicProposalConfirmation,
  StableChatRecoveryEngine,
} = require('../src/orchestrator/stable-chat-recovery');

function proposalDialogue(overrides = {}) {
  return {
    phase: 'confirm',
    kind: 'worker-A',
    allowPeer: false,
    proposal: {
      action: 'retry',
      rationale: 'The operator-approved policy decision is sufficient to continue.',
      guidance: 'Use @v1 under the explicitly accepted policy exception.',
    },
    ...overrides,
  };
}

test('exact generated confirmation binds the already displayed proposal without reinterpretation', () => {
  const result = deterministicProposalConfirmation(proposalDialogue(), EXACT_PROPOSAL_CONFIRMATION);
  assert.equal(result.action, 'retry');
  assert.equal(result.confirmedProposal, true);
  assert.equal(result.deterministicConfirmation, true);
  assert.match(result.rationale, /operator-approved policy decision/i);
  assert.match(result.guidance, /@v1/);
});

test('free-text confirmation-like messages still require recovery-model interpretation', () => {
  assert.equal(deterministicProposalConfirmation(proposalDialogue(), 'yes'), null);
  assert.equal(deterministicProposalConfirmation(proposalDialogue(), 'Continue, but change the guidance'), null);
  assert.equal(deterministicProposalConfirmation(proposalDialogue({ phase: 'discuss' }), EXACT_PROPOSAL_CONFIRMATION), null);
});

test('engine exact confirmation path does not create a recovery coordinator', async () => {
  let recoveryFactoryCalls = 0;
  const audits = [];
  const logs = [];
  const engine = new StableChatRecoveryEngine({
    client: {},
    sdk: {},
    workspace: '/repo',
    workspaceFolders: [{ name: 'repo', path: '/repo' }],
    models: {},
    ui: {
      log: (message) => logs.push(message),
      audit: (event) => audits.push(event),
    },
    revisionProvider: async () => 'R1',
  });
  engine.recoveryFactory = () => {
    recoveryFactoryCalls += 1;
    throw new Error('recoveryFactory must not be reached for exact generated confirmation');
  };

  const result = await engine.continueOperatorDialogue(
    { id: 'task-1', title: 'Test task', description: '', acceptanceCriteria: [] },
    proposalDialogue(),
    EXACT_PROPOSAL_CONFIRMATION,
    [],
  );

  assert.equal(recoveryFactoryCalls, 0);
  assert.equal(result.action, 'retry');
  assert.equal(result.deterministicConfirmation, true);
  assert.match(logs.join('\n'), /skipping redundant recovery-model confirmation/i);
  assert.equal(audits.at(-1).type, 'operator_proposal_confirmed_deterministically');
});
