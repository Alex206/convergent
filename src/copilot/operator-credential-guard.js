'use strict';

function hookToolArguments(input) {
  const raw = input?.toolArgs ?? input?.tool_input ?? input?.arguments ?? {};
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return { input: raw };
}

function shellText(input) {
  const args = hookToolArguments(input);
  return [args.command, args.fullCommandText, args.script, args.input, JSON.stringify(args)]
    .filter(Boolean)
    .join(' ');
}

function isShellTool(input) {
  const name = String(input?.toolName ?? input?.tool_name ?? '').toLowerCase();
  return /(bash|shell|powershell|terminal|cmd)/.test(name);
}

function isSensitiveCredentialName(name) {
  const normalized = String(name ?? '').trim().toUpperCase();
  if (!normalized) return false;
  return /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSCODE|CREDENTIALS?|PAT)(?:$|_)/.test(normalized)
    || /(?:^|_)(?:API|PRIVATE|ACCESS|SECRET)_KEY(?:$|_)/.test(normalized);
}

function assignedEnvironmentNames(input) {
  if (!isShellTool(input)) return [];
  const text = shellText(input);
  const names = new Set();
  const patterns = [
    /(?:^|[\s;&|])(?:export\s+|env\s+|set\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/g,
    /\bset\s+"([A-Za-z_][A-Za-z0-9_]*)\s*=/gi,
    /\bsetx\s+["']?([A-Za-z_][A-Za-z0-9_]*)["']?(?=\s|$)/gi,
    /(?:^|[\s;&|])unset\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
    /\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=/gi,
    /\b(?:Set-Item|New-Item|Set-Content|Remove-Item|Clear-Item)\s+(?:-Path\s+)?["']?Env:([A-Za-z_][A-Za-z0-9_]*)["']?(?=\s|;|$)/gi,
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
      .filter((name) => !this.authorizedNames.has(name));

    if (!blocked.length) return { permissionDecision: 'allow' };

    const key = String(agent ?? 'unknown');
    const entries = this.violations.get(key) ?? [];
    entries.push({ names: [...new Set(blocked)] });
    this.violations.set(key, entries);

    return {
      permissionDecision: 'deny',
      permissionDecisionReason: [
        `Convergent denied an attempt to synthesize, overwrite, persist, clear, or remove operator-controlled credential variable(s): ${blocked.join(', ')}.`,
        'Do not invent, replace, persist, or suppress token/secret/password/credential values. Use inherited credentials without mutating them; if a credential mutation is genuinely required, report BLOCKED so recovery can obtain explicit operator guidance.',
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

  const integrityCheck = `Convergent denied synthetic/overwrite/mutation of operator-controlled credential variable(s): ${names.join(', ')}.`;
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
      findings: report.findings ?? [],
      checks,
      summary: [
        `Required validation remains blocked because ${role} attempted to synthesize or mutate operator-controlled credential variable(s) ${names.join(', ')} and Convergent denied the mutation.`,
        'Operator context is required before retrying validation with those credentials.',
        originalSummary ? `Original ${role} summary: ${originalSummary}` : '',
      ].filter(Boolean).join(' '),
    },
    correction: `${role} verdict reconciled to BLOCKED after a denied credential mutation for ${names.join(', ')}.`,
  };
}

module.exports = {
  hookToolArguments,
  shellText,
  isSensitiveCredentialName,
  assignedEnvironmentNames,
  mentionedSensitiveCredentialNames,
  environmentHasCredential,
  OperatorCredentialGuard,
  reconcileCredentialIntegrityReport,
};
