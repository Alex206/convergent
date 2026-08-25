'use strict';

const { StableChatRecoveryEngine } = require('./stable-chat-recovery');
const { ReviewArchitectureSessionFactory } = require('../copilot/review-architecture-session-factory');
const {
  DEFAULT_REVIEW_ARCHITECTURE,
  normalizeReviewArchitecture,
} = require('./review-architecture');

function configuredReviewArchitecture(options = {}) {
  if (options.reviewArchitecture) return options.reviewArchitecture;
  try {
    return globalThis.__convergentReviewArchitectureProvider?.() ?? DEFAULT_REVIEW_ARCHITECTURE;
  } catch {
    return DEFAULT_REVIEW_ARCHITECTURE;
  }
}

class ReviewArchitectureEngine extends StableChatRecoveryEngine {
  constructor(options = {}) {
    const initial = normalizeReviewArchitecture(configuredReviewArchitecture(options));
    let checkpointArchitecture = initial.id;
    const originalOnCheckpoint = options.onCheckpoint;
    super({
      ...options,
      onCheckpoint: typeof originalOnCheckpoint === 'function'
        ? (state) => originalOnCheckpoint({ ...state, reviewArchitecture: checkpointArchitecture })
        : originalOnCheckpoint,
    });
    this.reviewArchitecture = initial;
    this._setCheckpointReviewArchitecture = (value) => {
      checkpointArchitecture = normalizeReviewArchitecture(value).id;
    };
  }

  sessionFactory() {
    const factory = super.sessionFactory();
    // The base factory has already established all command/runtime/credential
    // state. The 0.5 subclass only changes reviewer construction.
    Object.setPrototypeOf(factory, ReviewArchitectureSessionFactory.prototype);
    factory.reviewArchitecture = this.reviewArchitecture.id;
    return factory;
  }

  async run(userRequest, resumeState = null) {
    const saved = resumeState?.reviewArchitecture;
    if (saved) {
      const resumed = normalizeReviewArchitecture(saved);
      if (resumed.id !== this.reviewArchitecture.id) {
        this.ui?.log?.(`Resume keeps saved review architecture ${resumed.benchmarkId} ${resumed.label}; current workspace setting ${this.reviewArchitecture.id} applies only to new workflows.`);
      }
      this.reviewArchitecture = resumed;
    }
    this._setCheckpointReviewArchitecture(this.reviewArchitecture.id);
    this.ui?.log?.(`Review architecture: ${this.reviewArchitecture.benchmarkId} ${this.reviewArchitecture.label} (${this.reviewArchitecture.id}) — ${this.reviewArchitecture.description}`);
    try {
      void this.ui?.auditEvent?.({
        type: 'review_architecture_selected',
        id: this.reviewArchitecture.id,
        benchmarkId: this.reviewArchitecture.benchmarkId,
        label: this.reviewArchitecture.label,
        reviewerCount: this.reviewArchitecture.reviewerCount,
        modelFamily: this.reviewArchitecture.modelFamily,
        specialized: this.reviewArchitecture.specialized,
      });
    } catch {}
    return super.run(userRequest, resumeState);
  }
}

module.exports = {
  ReviewArchitectureEngine,
  configuredReviewArchitecture,
};
