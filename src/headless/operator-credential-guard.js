'use strict';

function shellText(input) {
  const args = input?.toolArgs ?? {};
  return [args.command, args.fullCommandText, args.script, args.input, JSON.stringify(args)]
    .filter(Boolean)
    .join(' ');
}

function isShellTool(input) {
  const name = String(input?.toolName ?? '').toLowerCase();
  return /(bash|shell|powershell|terminal|cmd)/.test(name);
}

function isSensitiveCredentialName(name) {
  const normalized = String(name ?? '').trim().toUpperCase();
  if (!normalized) return false;
  return /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSCODE|CREDENTIALS?)(?:$|_)/.test(normalized)
    || /(?:^|_)(?:API|PRIVATE|ACCESS|SECRET)_KEY(?:$|_)/.test(normalized);
}

function assignedEnvironmentNames(input) {
  if (!isShellTool(input)) return [];
  const text = shellText(input);
  const names = new Set();
  const patterns = [
    /(?:^|[\s;&|])(?:export\s+|env\s+|set\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/g,
    /\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=/gi,
    /\b(?:Set-Item|New-Item)\s+(?:-Path\s+)?Env:([A-Za-z_][A-Za-z0-9_]*)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) names.add(match[1].toUpperCase());
  }
  return [...names];
}

function mentionedSensitiveCredentialNames(text) {
  const words = String(text ?? '').match(/\b[A-Z][A-Z0-9_]*\b/g) ?? [];
  return [...new Set(words.filter(isSensitiveCredentialName))];
}

function environmentHasCredential(environment, name) {
  const normalized = String(name ?? '').toUpperCase();
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (String(key).toUpperCase() !== normalized) continue;
    return String(value ?? '').trim().length > 0;
  }
  return false;
}

class OperatorCredentialGuard {
  constructor({ environment = process.env } = {}) {
    this.environment = environment ?? {};
    this.authorizedNames = new Set();
    this.violations = new Map();
  }

  hook(input, { agent = 'unknown' } = {}) {
    const blocked = assignedEnvironmentNames(input)
      .filter(isSensitiveCredentialName)
      .filter((name) => !this.authorizedNames.has(name) && !environmentHasCredential(this.environment, name));

    if (!blocked.length) return { permissionDecision: 'allow' };

    const key = String(agent ?? 'unknown');
    const entries = this.violations.get(key) ?? [];
    entries.push({ names: [...new Set(blocked)] });
    this.violations.set(key, entries);

    return {
      permissionDecision: 'deny',
      permissionDecisionReason: [
        `Convergent denied an attempt to synthesize operator-controlled credential variable(s): ${blocked.join(', ')}.`,
        'Do not invent token/secret/password/credential values. Run validation with the inherited environment; if the required credential is missing, report BLOCKED with the exact prerequisite so recovery can obtain operator guidance.',
      ].join(' '),
    };
  }

  authorizeFromOperatorGuidance(guidance) {
    const text = String(guidance ?? '');
    if (!/\bOperator context:/i.test(text)) return [];
    const names = mentionedSensitiveCredentialNames(text);
    for (const name of names) this.authorizedNames.add(name);
    return names;
  }

  consumeViolations(agent) {
    const key = String(agent ?? 'unknown');
    const entries = this.violations.get(key) ?? [];
    this.violations.delete(key);
    return entries;
  }
}

function reconcileCredentialIntegrityReport(report, violations, role = 'agent') {
  if (!report || !violations?.length) return { report, correction: null };
  const names = [...new Set(
    violations.flatMap((entry) => entry?.names ?? []).map((name) => String(name).toUpperCase()),
  )].sort();
  if (!names.length) return { report, correction: null };

  const integrityCheck = `Convergent denied synthetic assignment to operator-controlled credential variable(s): ${names.join(', ')}.`;
  const checks = [...new Set([...(report.checks ?? []), integrityCheck])];
  if (report.verdict === 'blocked') {
    return {
      report: { ...report, checks },
      correction: `${role} credential-integrity denial preserved the existing BLOCKED verdict for ${names.join(', ')}.`,
    };
  }

  const originalSummary = String(report.summary ?? '').trim();
  return {
    report: {
      ...report,
      verdict: 'blocked',
      findings: [],
      checks,
      summary: [
        `Required validation remains blocked because ${role} attempted to synthesize operator-controlled credential variable(s) ${names.join(', ')} and Convergent denied the assignment.`,
        'Operator context is required before retrying validation with those credentials.',
        originalSummary ? `Original ${role} summary: ${originalSummary}` : '',
      ].filter(Boolean).join(' '),
    },
    correction: `${role} verdict reconciled to BLOCKED after a denied synthetic credential assignment for ${names.join(', ')}.`,
  };
}

module.exports = {
  shellText,
  isSensitiveCredentialName,
  assignedEnvironmentNames,
  mentionedSensitiveCredentialNames,
  environmentHasCredential,
  OperatorCredentialGuard,
  reconcileCredentialIntegrityReport,
};
