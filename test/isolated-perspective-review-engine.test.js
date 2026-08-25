'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ISOLATED_GENERIC_CONTROLLER_TOOLS,
  ISOLATED_PERSPECTIVE_CONTROLLER_TOOLS,
  ISOLATED_GENERIC_ADJUDICATOR_PROMPT,
  ISOLATED_PERSPECTIVE_CONTROLLER_PROMPT,
  IsolatedPerspectiveReviewSessionFactory,
  IsolatedPerspectiveReviewEngine,
} = require('../src/headless/isolated-perspective-review-engine');

const REPOSITORY_INSPECTION_TOOL = /(?:batch_view|run_command|view|grep|glob|rg|shell|command)/i;

test('panel Terra controller has reporting tools only and cannot inspect repository state', () => {
  assert.deepEqual(ISOLATED_GENERIC_CONTROLLER_TOOLS, [
    'custom:report_review',
  ]);
  assert.deepEqual(ISOLATED_PERSPECTIVE_CONTROLLER_TOOLS, [
    'custom:report_review_plan',
    'custom:report_review',
  ]);
  assert.equal(ISOLATED_GENERIC_CONTROLLER_TOOLS.some((tool) => REPOSITORY_INSPECTION_TOOL.test(tool)), false);
  assert.equal(ISOLATED_PERSPECTIVE_CONTROLLER_TOOLS.some((tool) => REPOSITORY_INSPECTION_TOOL.test(tool)), false);
});

test('panel Terra prompts explicitly assign repository-level defect discovery to Luna', () => {
  assert.match(ISOLATED_GENERIC_ADJUDICATOR_PROMPT, /NOT a fourth code reviewer/);
  assert.match(ISOLATED_GENERIC_ADJUDICATOR_PROMPT, /no repository inspection or command tools/);
  assert.match(ISOLATED_GENERIC_ADJUDICATOR_PROMPT, /do not originate a new repository-derived defect/i);

  assert.match(ISOLATED_PERSPECTIVE_CONTROLLER_PROMPT, /no repository inspection or command tools/);
  assert.match(ISOLATED_PERSPECTIVE_CONTROLLER_PROMPT, /all repository-level defect discovery.*belongs to Luna/i);
  assert.match(ISOLATED_PERSPECTIVE_CONTROLLER_PROMPT, /do not originate a new repository-derived defect/i);
});

test('isolated benchmark engine/factory remain drop-in subclasses of perspective harness', () => {
  assert.equal(typeof IsolatedPerspectiveReviewSessionFactory, 'function');
  assert.equal(typeof IsolatedPerspectiveReviewEngine, 'function');
});

test('headless panel runner instantiates the isolated engine rather than the inspection-capable harness engine', () => {
  const runner = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'headless', 'perspective-review-runner.js'),
    'utf8',
  );
  assert.match(runner, /new IsolatedPerspectiveReviewEngine\(/);
  assert.doesNotMatch(runner, /new PerspectiveReviewEngine\(/);
});