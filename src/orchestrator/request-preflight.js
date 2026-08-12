'use strict';

const MISSING_REFERENCE_PATTERNS = [
  /\b(?:this|here)\s+(?:was|is)\s+(?:the\s+)?(?:original\s+)?(?:request|prompt|task)\s*[:\-–—]*$/i,
  /\b(?:the\s+)?(?:request|prompt|task)\s+(?:was|is|follows)\s*[:\-–—]*$/i,
  /\b(?:here(?:'s| is)|below is)\s+(?:the\s+)?(?:original\s+)?(?:request|prompt|task)\s*[:\-–—]*$/i,
];

function referencesMissingObjective(value) {
  const text = String(value ?? '').trim();
  if (!text) return true;
  return MISSING_REFERENCE_PATTERNS.some((pattern) => pattern.test(text));
}

function missingRequestError() {
  const error = new Error('The message refers to a request/prompt that was not included. Paste the actual request to continue.');
  error.code = 'CONVERGENT_MISSING_REQUEST';
  return error;
}

async function ensureConcreteUserRequest(value, userInputHandler, onClarification) {
  const text = String(value ?? '').trim();
  if (!referencesMissingObjective(text)) return { request: text, clarified: false };

  if (typeof userInputHandler !== 'function') throw missingRequestError();

  onClarification?.('The message refers to a request/prompt that is not present. Asking for the missing objective before starting the coordinator.');
  const response = await userInputHandler({
    question: 'I do not see the actual request after your reference to it. Please paste the original request/task you want Convergent to continue.',
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
