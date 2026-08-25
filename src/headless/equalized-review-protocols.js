'use strict';

const { REVIEWER_PROMPT } = require('../orchestrator/prompts');
const {
  REVIEW_PROTOCOLS,
  REVIEW_PROTOCOL_IDS,
  formatReviewProtocolCatalog,
} = require('./review-protocols');

const REVIEWER_ONLY_ARMS = Object.freeze({
  'terra-broad': Object.freeze({
    label: '1 Terra reviewer · complete broad review',
    modelFamily: 'terra',
    reviewerCount: 1,
    specialization: false,
  }),
  'luna-broad-3': Object.freeze({
    label: '3 Luna reviewers · complete broad review each',
    modelFamily: 'luna',
    reviewerCount: 3,
    specialization: false,
  }),
  'luna-specialized-3': Object.freeze({
    label: '3 Luna reviewers · fixed complementary specializations',
    modelFamily: 'luna',
    reviewerCount: 3,
    specialization: true,
  }),
});

const SPECIALIZED_PARTITIONS = Object.freeze([
  Object.freeze({
    id: 'contract-integration',
    label: 'contract + integration/compatibility',
    protocols: Object.freeze(['contract', 'integration-compatibility']),
  }),
  Object.freeze({
    id: 'adversarial-security',
    label: 'adversarial + security/trust',
    protocols: Object.freeze(['adversarial', 'security-trust']),
  }),
  Object.freeze({
    id: 'state-resources',
    label: 'state/data-flow + concurrency/resources',
    protocols: Object.freeze(['state-dataflow', 'concurrency-resources']),
  }),
]);

function validatePartitions(partitions = SPECIALIZED_PARTITIONS) {
  const selected = partitions.flatMap((entry) => entry.protocols);
  const expected = [...REVIEW_PROTOCOL_IDS].sort();
  const actual = [...selected].sort();
  if (new Set(selected).size !== selected.length) {
    throw new Error('Specialized reviewer partitions must not overlap.');
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Specialized reviewer partitions must cover every review protocol exactly once. Got: ${actual.join(', ')}`);
  }
  return true;
}

validatePartitions();

const EQUALIZED_REVIEW_METHOD = `
${REVIEWER_PROMPT}

Reviewer-only benchmark contract:
- The implementation is already present in a FROZEN repository snapshot. You are evaluating it only; there is no implementer or remediation phase in this experiment.
- The snapshot may be correct or may contain one or more defects. Do not assume either outcome.
- Review the implementation and its tests against the supplied task requirements. Do not treat existing tests as proof of correctness.
- Use the same bounded, evidence-driven review method regardless of model or panel architecture.

Completeness requirements before CLEAN:
1. Map every material requirement and negative requirement to the relevant implementation behavior.
2. Inspect the complete changed/targeted behavior plus directly affected callers, contracts, and tests needed to establish correctness.
3. Challenge important assumptions with concrete witnesses, not only code reading. Consider boundary values, malformed-but-plausible input, unusual ordering, repeated operations, partial failure, and combinations of otherwise valid operations when relevant.
4. Track important values, ownership, aliases, state transitions, resources, and trust boundaries through intermediate steps as well as final state. A final valid-looking state does not prove every intermediate transition was valid.
5. Check compatibility with the declared public/internal contract and previously valid input shapes/types. Avoid accidentally strengthening accepted-input requirements.
6. Check exception precedence, cleanup, cancellation, retries, idempotence, concurrency/resource lifetime, authorization/validation, and failure-open/failure-closed behavior whenever the task touches those concerns.
7. Evaluate whether tests actually exercise the risky semantics. A missing test is a finding only when it corresponds to a concrete unverified requirement/regression risk; prefer demonstrating the underlying defect when possible.
8. Before reporting CLEAN, attempt at least one plausible falsifying witness for every review dimension that is materially relevant to this task.
9. Report only actionable defects supported by concrete repository evidence. Do not report style preferences, speculative hardening, or unrelated cleanup.

The following reusable aspect catalog defines the complete review surface. Every reviewer receives this exact catalog:

${formatReviewProtocolCatalog()}
`.trim();

function broadReviewPrompt() {
  return `${EQUALIZED_REVIEW_METHOD}\n\nASSIGNMENT: BROAD. Cover every materially relevant aspect in the complete catalog. No other reviewer is assumed to cover anything for you.`;
}

function specializedReviewPrompt(partition) {
  if (!partition || !Array.isArray(partition.protocols) || !partition.protocols.length) {
    throw new Error('A specialized review partition is required.');
  }
  for (const protocolId of partition.protocols) {
    if (!Object.hasOwn(REVIEW_PROTOCOLS, protocolId)) {
      throw new Error(`Unknown specialized review protocol: ${protocolId}`);
    }
  }
  const assigned = partition.protocols.map((id) => `${id}: ${REVIEW_PROTOCOLS[id].label}`).join(', ');
  return `${EQUALIZED_REVIEW_METHOD}\n\nASSIGNMENT: SPECIALIZED PANEL MEMBER. You receive the same complete method and catalog as every other reviewer, but for search diversity you OWN these aspects and should spend most of your review budget on them: ${assigned}. Do not assume another reviewer will catch defects inside your assigned aspects. You may still report an obvious concrete defect outside the assignment if encountered, but do not turn the pass back into an undifferentiated broad review.`;
}

function reviewArmConfig(value) {
  const arm = String(value ?? '').trim().toLowerCase();
  if (!Object.hasOwn(REVIEWER_ONLY_ARMS, arm)) {
    throw new Error(`Unsupported reviewer-only arm ${JSON.stringify(value)}. Expected one of: ${Object.keys(REVIEWER_ONLY_ARMS).join(', ')}.`);
  }
  return { arm, ...REVIEWER_ONLY_ARMS[arm] };
}

module.exports = {
  REVIEWER_ONLY_ARMS,
  SPECIALIZED_PARTITIONS,
  EQUALIZED_REVIEW_METHOD,
  validatePartitions,
  broadReviewPrompt,
  specializedReviewPrompt,
  reviewArmConfig,
};
