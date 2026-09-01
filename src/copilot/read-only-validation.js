'use strict';

// Reviewer read-only means Git-visible workspace state must stay unchanged, not
// merely that the model avoids explicit edit tools. Build/test tools can have
// incidental source-tree side effects (for example Cargo creating Cargo.lock),
// so known validation modes with such effects are rejected before execution.
function shellCommandText(input) {
  if (typeof input === 'string') return input.trim();
  const raw = input?.toolArgs ?? input?.tool_input ?? input?.arguments ?? {};
  let args = raw;
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw); } catch { args = { input: raw }; }
  }
  if (!args || typeof args !== 'object') args = {};
  return [args.command, args.fullCommandText, args.script, args.input]
    .filter(Boolean)
    .map(String)
    .join(' ')
    .trim();
}

function isReviewerOwner(owner) {
  return /reviewer/i.test(String(owner ?? ''));
}

function cargoValidationWithoutLock(command) {
  const text = String(command ?? '');
  const cargoInvocation = /\bcargo\s+(?:\+[^\s]+\s+)?(?:test|check|clippy|build|bench|doc|metadata|run)\b[^;|\r\n]*/gi;
  for (const match of text.matchAll(cargoInvocation)) {
    if (!/\s--(?:locked|frozen)(?:\s|$)/i.test(match[0])) return true;
  }
  return false;
}

function mutatingValidationCommand(command) {
  const text = String(command ?? '');
  return /\bcargo\s+(?:\+[^\s]+\s+)?fmt\b(?![^;|\r\n]*\s--check\b)|\b(?:prettier|biome)\b[^;|\r\n]*\s--write\b|\beslint\b[^;|\r\n]*\s--fix\b|\bclang-format\b[^;|\r\n]*(?:\s-i\b|\s--in-place\b)|\bgofmt\b[^;|\r\n]*\s-w\b|\bdotnet\s+format\b(?![^;|\r\n]*\s--verify-no-changes\b)/i.test(text);
}

function reviewerValidationPolicy(owner, commandOrInput) {
  if (!isReviewerOwner(owner)) return { allowed: true };
  const command = shellCommandText(commandOrInput);
  if (!command) return { allowed: true };

  if (mutatingValidationCommand(command)) {
    return {
      allowed: false,
      reason: 'Reviewer validation is read-only. Run formatter/linter verification in a non-writing mode (for example cargo fmt --check or dotnet format --verify-no-changes) instead of modifying the reviewed workspace.',
    };
  }

  if (cargoValidationWithoutLock(command)) {
    return {
      allowed: false,
      reason: 'Reviewer Cargo validation must preserve Git-visible workspace state. Use --locked or --frozen so Cargo cannot create/update Cargo.lock. If this repository intentionally has no lockfile, do not create one during review; rely on existing validation evidence or report the validation limitation.',
    };
  }

  return { allowed: true };
}

module.exports = {
  shellCommandText,
  isReviewerOwner,
  cargoValidationWithoutLock,
  mutatingValidationCommand,
  reviewerValidationPolicy,
};
