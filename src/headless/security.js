'use strict';

const SENSITIVE_ENV_NAMES = [
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
];

function sensitiveEnvironmentCommand(command) {
  const text = String(command ?? '');
  if (!text.trim()) return false;

  const upper = text.toUpperCase();
  if (SENSITIVE_ENV_NAMES.some((name) => upper.includes(name))) return true;

  return [
    /(?:^|[;&|]\s*)\b(?:printenv|env)\b(?:\s|$)/i,
    /(?:^|[;&|]\s*)\bset\b\s*(?:$|[;&|])/i,
    /\b(?:Get-ChildItem|Get-Item|gci|gi|dir|ls)\s+Env:/i,
    /\[\s*(?:System\.)?Environment\s*\]\s*::\s*GetEnvironmentVariables?/i,
    /\bprocess\.env\b/i,
    /\bos\.environ\b/i,
  ].some((pattern) => pattern.test(text));
}

module.exports = {
  SENSITIVE_ENV_NAMES,
  sensitiveEnvironmentCommand,
};
