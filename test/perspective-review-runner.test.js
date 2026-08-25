'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REVIEW_ARMS,
  reviewArmConfig,
} = require('../src/headless/perspective-review-runner');
const {
  PANEL_MODES,
  GENERIC_PANEL_SIZE,
  GENERIC_REVIEW_CONTROLLER_TOOLS,
  REVIEW_CONTROLLER_TOOLS,
  PerspectiveReviewSessionFactory,
  PerspectiveReviewEngine,
} = require('../src/headless/perspective-review-engine');
const {
  BROAD_TERRA_ARM,
  REVIEW_BENCHMARK_ARMS,
  validateArm,
} = require('../src/headless/perspective-review-cli');

test('review benchmark exposes broad, generic-panel, and perspective-panel arms', () => {
  assert.equal(BROAD_TERRA_ARM, 'broad-terra');
  assert.deepEqual(REVIEW_BENCHMARK_ARMS, [
    'broad-terra',
    'generic-luna-panel-terra',
    'perspective-luna-terra',
  ]);
  assert.equal(validateArm('PERSPECTIVE-LUNA-TERRA'), 'perspective-luna-terra');
  assert.throws(() => validateArm('typed-evidence-no-peer'), /Unsupported --arm/);
});

test('panel arms map to generic or perspective review modes', () => {
  assert.equal(reviewArmConfig('generic-luna-panel-terra').reviewMode, PANEL_MODES.generic);
  assert.equal(reviewArmConfig('perspective-luna-terra').reviewMode, PANEL_MODES.perspective);
  assert.equal(Object.keys(REVIEW_ARMS).length, 2);
  assert.equal(GENERIC_PANEL_SIZE, 3);
});

test('perspective controller can plan while generic control is adjudication-only', () => {
  assert.equal(REVIEW_CONTROLLER_TOOLS.includes('custom:report_review_plan'), true);
  assert.equal(REVIEW_CONTROLLER_TOOLS.includes('custom:report_review'), true);
  assert.equal(GENERIC_REVIEW_CONTROLLER_TOOLS.includes('custom:report_review_plan'), false);
  assert.equal(GENERIC_REVIEW_CONTROLLER_TOOLS.includes('custom:report_review'), true);
  assert.equal(REVIEW_CONTROLLER_TOOLS.some((tool) => /probe|observer|evidence/.test(tool)), false);
  assert.equal(GENERIC_REVIEW_CONTROLLER_TOOLS.some((tool) => /probe|observer|evidence/.test(tool)), false);
  assert.equal(typeof PerspectiveReviewSessionFactory, 'function');
  assert.equal(typeof PerspectiveReviewEngine, 'function');
});
