'use strict';

const {
  RecoveryConvergentEngine,
  operatorRecoveryScopeKey,
  queueRecoveryInstruction,
} = require('./recovery-engine');
const { requireReport, taskPrompt } = require('./engine');
const { pauseWorkflow } = require('./control');

const OPERATOR_DIALOGUE_CODE = 'CONVERGENT_OPERATOR_DIALOGUE';
const MAX_DIALOGUE_HISTORY_ITEMS = 12;
const MAX_DIALOGUE_TEXT_CHARS = 1800;

class OperatorDialogueRequestedError extends Error {
  constructor(question, request = {}) {
    super(String(question ?? '').trim() || 'Convergent needs operator clarification.');
    this.name = 'OperatorDialogueRequestedError';
    this.code = OPERATOR_DIALOGUE_CODE;
    this.question = String(question ?? '').trim();
    this.request = request && typeof request === 'object' ? request : {};
  }
}

function isOperatorDialogueRequestedError(error) {
  return error?.code === OPERATOR_DIALOGUE_CODE;
}

function createDeferredOperatorInputHandler(choiceHandler = null) {
  const handler = async (request = {}) => {
    if (Array.isArray(request.choices) && request.choices.length && typeof choiceHandler === 'function') {
      return choiceHandler(request);
    }
    throw new OperatorDialogueRequestedError(request.question, request);
  };
  // The engine itself uses the deferred handler only at recovery boundaries.
  // Normal Copilot sessions (notably the planning coordinator's builtin ask_user)
  // retain the ordinary VS Code input handler so a pre-plan clarification does
  // not masquerade as a resumable recovery dialogue with no task checkpoint.
  handler.fallback = typeof choiceHandler === 'function' ? choiceHandler : null;
  return handler;
}

function boundedDialogueText(value, maxChars = MAX_DIALOGUE_TEXT_CHARS) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) return '';
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function boundedDialogueHistory(items) {
  return (Array.isArray(items) ? items : [])
    .slice(-MAX_DIALOGUE_HISTORY_ITEMS)
    .map((item) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: boundedDialogueText(item?.content),
    }))
    .filter((item) => item.content);
}

function formatDialogueHistory(items, title = 'Persisted operator/recovery dialogue') {
  const history = boundedDialogueHistory(items);
  if (!history.length) return `${title}: none.`;
  return [
    `${title}:`,
    ...history.map((item) => `${item.role === 'assistant' ? 'Convergent' : 'Operator'}: ${item.content}`),
  ].join('\n');
}

function allowedActionsText(allowPeer) {
  return allowPeer ? 'retry, peer, ask_user, or pause' : 'retry, ask_user, or pause';
}

function bindConfirmationToProposal(report, proposal) {
  if (!proposal || !['retry', 'peer'].includes(proposal.action)) {
    return {
      action: 'ask_user',
      rationale: 'The saved confirmation proposal is missing or invalid, so Convergent will not infer authorization.',
      question: 'The proposed continuation could not be verified. Please restate or clarify the next step you want Convergent to take.',
      guidance: '',
    };
  }
  if (!['retry', 'peer'].includes(report?.action)) return report;
  if (report.action !== proposal.action) {
    return {
      action: 'ask_user',
      rationale: `Your reply was interpreted as ${report.action}, but the proposal shown for confirmation was ${proposal.action}. Convergent will not silently change the proposed action during confirmation.`,
      question: `Do you want to keep the previously proposed ${proposal.action} action, or change the proposal? Please clarify before Convergent continues.`,
      guidance: '',
    };
  }
  return {
    action: proposal.action,
    rationale: boundedDialogueText(proposal.rationale, 2400),
    question: '',
    guidance: boundedDialogueText(proposal.guidance, 5000),
    confirmedProposal: true,
  };
}

class StableChatRecoveryEngine extends RecoveryConvergentEngine {
  constructor(options) {
    super(options);
    this.activeOperatorRecoveryAgreement = null;
  }

  sessionFactory() {
    const deferred = this.userInputHandler;
    const ordinary = deferred?.fallback;
    if (!ordinary) return super.sessionFactory();
    this.userInputHandler = ordinary;
    try {
      return super.sessionFactory();
    } finally {
      this.userInputHandler = deferred;
    }
  }

  async runTask(factory, task, taskSessionKey, routing, taskResumeState = null) {
    const previous = this.activeOperatorRecoveryAgreement;
    this.activeOperatorRecoveryAgreement = taskResumeState?.operatorRecoveryAgreement ?? null;
    try {
      return await super.runTask(factory, task, taskSessionKey, routing, taskResumeState);
    } finally {
      this.activeOperatorRecoveryAgreement = previous;
    }
  }

  consumeOperatorAgreement(task, kind, { allowPeer = false } = {}) {
    const agreement = this.activeOperatorRecoveryAgreement;
    if (!agreement || agreement.consumed === true) return null;
    const scopeKey = operatorRecoveryScopeKey(task, kind);
    if (agreement.scopeKey && agreement.scopeKey !== scopeKey) return null;

    const action = String(agreement.action ?? 'pause');
    if (action === 'peer' && !allowPeer) {
      pauseWorkflow(
        `The saved operator agreement requested peer recovery for ${kind}, but this recovery path has no peer.`,
        { kind: 'operator_agreement_invalid', task: task.id, recoveryKind: kind, agreement },
      );
    }
    if (!['retry', 'peer'].includes(action)) {
      pauseWorkflow(
        `The saved operator agreement for ${kind} did not authorize a retry or peer continuation.`,
        { kind: 'operator_agreement_invalid', task: task.id, recoveryKind: kind, agreement },
      );
    }

    const guidance = boundedDialogueText(agreement.guidance, 5000);
    const authorizedCredentialNames = this.operatorCredentialGuard?.authorizeFromOperatorGuidance(guidance) ?? [];
    agreement.consumed = true;
    this.operatorRecoveryHistory.set(scopeKey, {
      consumed: true,
      action,
      guidance,
    });
    this.ui?.log?.(`Applying explicit operator Chat agreement for ${task.id}/${kind}: ${action}; no recovery-model re-interpretation before the agreed continuation.`);
    if (authorizedCredentialNames.length) {
      this.ui?.log?.(`Operator Chat agreement authorized credential variable name(s): ${authorizedCredentialNames.join(', ')}.`);
    }
    this.ui?.audit?.({
      type: 'operator_chat_agreement_applied',
      taskId: task.id,
      kind,
      action,
      rationale: boundedDialogueText(agreement.rationale),
      authorizedCredentialNames,
    });
    return {
      action,
      rationale: boundedDialogueText(agreement.rationale) || 'Operator explicitly confirmed this recovery continuation in Chat.',
      guidance,
      operatorAgreed: true,
      authorizedCredentialNames,
    };
  }

  async consultRecoveryCoordinator(task, kind, detail, options = {}) {
    const agreed = this.consumeOperatorAgreement(task, kind, options);
    if (agreed) return agreed;
    return super.consultRecoveryCoordinator(task, kind, detail, options);
  }

  applyStrongReviewAgreement(task, reviewer) {
    const agreed = this.consumeOperatorAgreement(task, 'strong-reviewer', { allowPeer: false });
    if (!agreed) return null;
    if (agreed.action !== 'retry') {
      pauseWorkflow(
        `The saved operator agreement cannot apply action ${agreed.action} to the required strong-review gate.`,
        { kind: 'operator_agreement_invalid', task: task.id, recoveryKind: 'strong-reviewer', agreement: agreed },
      );
    }
    queueRecoveryInstruction(reviewer?.session, agreed.guidance || agreed.rationale);
    this.ui?.phase?.('Applying agreed review recovery', 'The strong reviewer will retry from the saved review boundary with the operator-confirmed guidance.');
    return agreed;
  }

  async runStrongReview(task, workerA, workerB, reviewer, ...rest) {
    this.applyStrongReviewAgreement(task, reviewer);
    return super.runStrongReview(task, workerA, workerB, reviewer, ...rest);
  }

  async continueOperatorDialogue(task, dialogue, userMessage, chatHistory = []) {
    const kind = String(dialogue?.kind ?? 'worker-A');
    const allowPeer = Boolean(dialogue?.allowPeer);
    const phase = dialogue?.phase === 'confirm' ? 'confirm' : 'discuss';
    const factory = this.recoveryFactory();
    const coordinator = await factory.createRecoveryCoordinator(task.id, `${kind}-chat-dialogue`);
    this.sessions.push(coordinator.session);

    const persistedHistory = boundedDialogueHistory(dialogue?.history);
    const stableChatHistory = boundedDialogueHistory(chatHistory);
    const proposal = dialogue?.proposal && typeof dialogue.proposal === 'object' ? dialogue.proposal : null;
    const currentMessage = boundedDialogueText(userMessage, 3000);
    const allowed = allowedActionsText(allowPeer);

    const phaseContract = phase === 'confirm'
      ? [
          'CONFIRMATION PHASE.',
          `The previously proposed action is ${proposal?.action ?? '<missing>'}.`,
          `Proposed rationale: ${boundedDialogueText(proposal?.rationale)}`,
          `Proposed next-agent guidance: ${boundedDialogueText(proposal?.guidance, 4000)}`,
          'Return that same retry/peer action ONLY if the operator clearly confirms this exact interpretation and continuation.',
          'Do not alter the proposal while confirming it. Any requested change, qualification, question, disagreement, or ambiguity requires ask_user and a return to discussion.',
          'If the operator explicitly wants to stop or defer, use pause.',
        ]
      : [
          'DISCUSSION PHASE.',
          'The operator may be answering, asking why, challenging an assumption, correcting scope, or supplying only part of the missing information.',
          'Do not treat the latest operator message as automatic permission to continue.',
          'If shared understanding is still incomplete, use ask_user. In rationale, explain the relevant point concisely; in question, ask the next focused question without repeating facts already answered.',
          'If enough shared understanding exists, return retry or peer as a PROPOSAL. Convergent will ask the operator to confirm that proposal in a later Chat turn before executing it.',
          'Use pause only if continuing the discussion or workflow is currently inappropriate.',
        ];

    try {
      this.ui?.phase?.('Recovery discussion', `Strong coordinator is interpreting the operator's Chat reply for ${kind} on task ${task.id}; implementation remains paused.`);
      const startedAt = Date.now();
      let report = await requireReport(
        coordinator.session,
        coordinator.sink,
        [
          taskPrompt(task),
          '',
          `RECOVERY KIND: ${kind}`,
          `Allowed report actions: ${allowed}.`,
          `Original blocked summary: ${boundedDialogueText(dialogue?.summary, 2400)}`,
          dialogue?.findings?.length ? `Unresolved findings from the blocked pass:\n${dialogue.findings.slice(0, 12).map((item) => `- ${boundedDialogueText(item, 900)}`).join('\n')}` : '',
          dialogue?.checks?.length ? `Checks/evidence from the blocked pass:\n${dialogue.checks.slice(0, 12).map((item) => `- ${boundedDialogueText(item, 900)}`).join('\n')}` : '',
          '',
          formatDialogueHistory(persistedHistory),
          stableChatHistory.length ? `\n${formatDialogueHistory(stableChatHistory, 'Recent stable VS Code @convergent Chat history (supplemental)')}` : '',
          '',
          `Latest operator message:\n${currentMessage}`,
          '',
          ...phaseContract,
          '',
          'This is a recovery-dialogue turn only. Do not implement, edit files, run broad repository exploration, or silently continue the workflow. Call report_recovery exactly once.',
        ].filter(Boolean).join('\n'),
        'report_recovery',
        this.agentTurnTimeoutMs,
      );
      await this.finishTurn(coordinator, startedAt);
      if (phase === 'confirm') report = bindConfirmationToProposal(report, proposal);
      return report;
    } finally {
      await coordinator.session.disconnect?.().catch(() => {});
      this.sessions = this.sessions.filter((session) => session !== coordinator.session);
    }
  }
}

module.exports = {
  OPERATOR_DIALOGUE_CODE,
  OperatorDialogueRequestedError,
  isOperatorDialogueRequestedError,
  createDeferredOperatorInputHandler,
  boundedDialogueText,
  boundedDialogueHistory,
  formatDialogueHistory,
  bindConfirmationToProposal,
  StableChatRecoveryEngine,
};
