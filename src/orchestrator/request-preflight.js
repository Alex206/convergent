'use strict';

const MISSING_REFERENCE_PATTERNS = [
  /\b(?:this|here)\s+(?:was|is)\s+(?:the\s+)?(?:original\s+)?(?:request|prompt|task)\s*[:\-–—]*$/i,
  /\b(?:the\s+)?(?:request|prompt|task)\s+(?:was|is|follows)\s*[:\-–—]*$/i,
  /\b(?:here(?:'s| is)|below is)\s+(?:the\s+)?(?:original\s+)?(?:request|prompt|task)\s*[:\-–—]*$/i,
];

const REFERENTIAL_OBJECT = '(?:this|that|it|the\\s+above|this\\s+(?:change|request|task)|that\\s+(?:change|request|task)|the\\s+previous\\s+(?:change|request|task|discussion|conversation)|what\\s+we\\s+discussed)';
const REFERENTIAL_ACTION = new RegExp(
  `^(?:please\\s+)?(?:implement|do|continue|finish|complete|handle|take\\s+over|work\\s+on|review|fix|apply|execute|proceed\\s+with)\\s+${REFERENTIAL_OBJECT}(?:\\s*(?:,?\\s+(?:and|then)\\s+[^.!?]{1,120}))?[.!?]*$`,
  'i',
);
const CONTINUATION_ONLY = /^(?:please\s+)?(?:continue|proceed|go\s+ahead|take\s+it\s+from\s+here|pick\s+(?:this|it)\s+up|carry\s+on|continue\s+from\s+(?:above|there))(?:\s+(?:please|now))?[.!?]*$/i;

function referencesMissingObjective(value) {
  const text = String(value ?? '').trim();
  if (!text) return true;
  return MISSING_REFERENCE_PATTERNS.some((pattern) => pattern.test(text))
    || REFERENTIAL_ACTION.test(text)
    || CONTINUATION_ONLY.test(text);
}

function missingRequestError() {
  const error = new Error('The message refers to context that Convergent cannot safely resolve. Paste the concrete request or a short handoff to continue.');
  error.code = 'CONVERGENT_MISSING_REQUEST';
  return error;
}

async function ensureConcreteUserRequest(value, userInputHandler, onClarification) {
  const text = String(value ?? '').trim();
  if (!referencesMissingObjective(text)) return { request: text, clarified: false };

  if (typeof userInputHandler !== 'function') throw missingRequestError();

  onClarification?.('The message depends on preceding chat context that is not available to Convergent. Asking for a concrete task before starting the coordinator.');
  const response = await userInputHandler({
    question: 'I cannot safely resolve this reference from the current @convergent message. VS Code does not expose messages addressed to the normal Copilot agent to this chat participant. Please paste the concrete task or a short handoff with the decisions/constraints Convergent should continue from.',
    choices: [],
  });
  const answer = String(response?.answer ?? '').trim();
  if (!answer || /^User cancelled the clarification request\.?$/i.test(answer)) throw missingRequestError();
  if (referencesMissingObjective(answer)) throw missingRequestError();

  return { request: answer, clarified: true, original: text };
}

module.exports = {
  referencesMissingObjective,
  ensureConcreteUserRequest,
};
