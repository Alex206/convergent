'use strict';

const { usesPeerConvergence } = require('../orchestrator/routing');
const { operatorRecoveryScopeKey, recoveryDetailItem } = require('../orchestrator/recovery-engine');
const { boundedDialogueText, boundedDialogueHistory } = require('../orchestrator/stable-chat-recovery');

const MAX_OPERATOR_REPLIES = 6;

function pendingOperatorDialogue(state) {
  const dialogue = state?.taskState?.operatorDialogue;
  return dialogue && dialogue.status === 'pending' ? dialogue : null;
}

function taskForResumeState(state) {
  if (!state?.plan?.tasks?.length) return null;
  const index = Number.isInteger(state.currentTaskIndex) ? state.currentTaskIndex : state.startTaskIndex;
  return state.plan.tasks[index] ?? null;
}

function blockerContextFromCheckpoint(state) {
  const taskState = state?.taskState ?? {};
  if (taskState.stage === 'worker_blocked') {
    const report = taskState.blockedPass?.report ?? {};
    const worker = taskState.worker ?? taskState.blockedPass?.worker ?? 'A';
    return {
      kind: `worker-${worker}`,
      allowPeer: usesPeerConvergence(taskState.routing ?? {}),
      summary: boundedDialogueText(report.summary, 2400),
      findings: (report.findings ?? []).slice(0, 12).map((item) => recoveryDetailItem(item)),
      checks: (report.checks ?? []).slice(0, 12).map((item) => recoveryDetailItem(item)),
    };
  }
  if (taskState.stage === 'strong_review_blocked') {
    return {
      kind: 'strong-reviewer',
      allowPeer: false,
      summary: boundedDialogueText(taskState.summary, 2400),
      findings: [],
      checks: (taskState.evidence ?? []).slice(0, 12).map((item) => recoveryDetailItem(item)),
    };
  }
  return null;
}

function createInitialOperatorDialogue(state, question) {
  const task = taskForResumeState(state);
  const blocker = blockerContextFromCheckpoint(state);
  if (!task || !blocker) return null;
  const text = boundedDialogueText(question, 5000);
  return {
    version: 1,
    status: 'pending',
    phase: 'discuss',
    taskId: task.id,
    kind: blocker.kind,
    allowPeer: blocker.allowPeer,
    scopeKey: operatorRecoveryScopeKey(task, blocker.kind),
    question: text,
    rationale: '',
    summary: blocker.summary,
    findings: blocker.findings,
    checks: blocker.checks,
    history: text ? [{ role: 'assistant', content: text }] : [],
    replies: 0,
    proposal: null,
    updatedAt: new Date().toISOString(),
  };
}

function stateWithOperatorDialogue(state, dialogue, reason = 'Awaiting operator Chat discussion.') {
  return {
    ...state,
    status: 'interrupted',
    taskState: {
      ...(state?.taskState ?? {}),
      operatorDialogue: dialogue,
    },
    interruptionReason: reason,
    interruptedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function stateWithOperatorAgreement(state, dialogue, report) {
  const agreement = {
    action: report.action,
    rationale: boundedDialogueText(report.rationale, 2400),
    guidance: boundedDialogueText(report.guidance, 5000),
    scopeKey: dialogue.scopeKey,
    consumed: false,
    agreedAt: new Date().toISOString(),
  };
  const nextTaskState = { ...(state?.taskState ?? {}) };
  delete nextTaskState.operatorDialogue;
  nextTaskState.operatorRecoveryAgreement = agreement;
  delete nextTaskState.recoveryDecision;
  return {
    ...state,
    status: 'interrupted',
    taskState: nextTaskState,
    interruptionReason: 'Operator Chat agreement reached; ready to continue from saved checkpoint.',
    interruptedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function stateWithDialoguePause(state, dialogue, rationale) {
  const nextTaskState = { ...(state?.taskState ?? {}) };
  delete nextTaskState.operatorDialogue;
  nextTaskState.recoveryDecision = {
    action: 'pause',
    rationale: boundedDialogueText(rationale, 2400) || 'Operator/recovery discussion paused.',
    guidance: '',
  };
  return {
    ...state,
    status: 'interrupted',
    taskState: nextTaskState,
    interruptionReason: nextTaskState.recoveryDecision.rationale,
    interruptedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function responsePartText(part) {
  if (!part) return '';
  if (typeof part === 'string') return part;
  if (typeof part.value === 'string') return part.value;
  if (typeof part.value?.value === 'string') return part.value.value;
  if (typeof part.message === 'string') return part.message;
  return '';
}

function stableChatHistory(history) {
  const items = [];
  for (const turn of Array.isArray(history) ? history : []) {
    if (typeof turn?.prompt === 'string' && turn.prompt.trim()) {
      items.push({ role: 'user', content: turn.prompt });
      continue;
    }
    if (Array.isArray(turn?.response)) {
      const text = turn.response.map(responsePartText).filter(Boolean).join('\n');
      if (text.trim()) items.push({ role: 'assistant', content: text });
    }
  }
  return boundedDialogueHistory(items);
}

function dialogueFollowups(dialogue) {
  if (!dialogue || dialogue.status !== 'pending') return [];
  if (dialogue.phase === 'confirm') {
    return [
      { prompt: 'Continue with this interpretation', label: 'Continue with this interpretation' },
      { prompt: 'I want to change this interpretation', label: 'Change this interpretation' },
      { prompt: 'Explain this before continuing', label: 'Explain this first' },
    ];
  }
  return [
    { prompt: 'Explain why this is needed', label: 'Explain why this is needed' },
    { prompt: 'I disagree with that assumption', label: 'Challenge the assumption' },
    { prompt: 'Propose the safest next step', label: 'Propose the safest next step' },
  ];
}

function chatResultForDialogue(dialogue, extra = {}) {
  return {
    metadata: {
      convergentKind: 'operator_dialogue',
      convergentDialoguePhase: dialogue?.phase ?? 'discuss',
      convergentFollowups: dialogueFollowups(dialogue),
      ...extra,
    },
  };
}

module.exports = {
  MAX_OPERATOR_REPLIES,
  pendingOperatorDialogue,
  taskForResumeState,
  blockerContextFromCheckpoint,
  createInitialOperatorDialogue,
  stateWithOperatorDialogue,
  stateWithOperatorAgreement,
  stateWithDialoguePause,
  stableChatHistory,
  dialogueFollowups,
  chatResultForDialogue,
};
