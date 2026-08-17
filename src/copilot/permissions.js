'use strict';

const path = require('node:path');

const SENSITIVE_ENV_NAMES = [
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_COPILOT_API_TOKEN',
];

function isWithin(root, candidate) {
  if (!candidate) return false;
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

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

function riskyCommand(command) {
  const text = String(command ?? '');
  return sensitiveEnvironmentCommand(text)
    || /\bgit\s+push\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[^\n]*f|\brm\s+-[^\n]*r[^\n]*f|\bRemove-Item\b[^\n]*-Recurse[^\n]*-Force|\bformat\b|\bshutdown\b/i.test(text);
}

function createPermissionHandler(vscode, workspace, mode, output, options = {}) {
  return async (request) => {
    const approve = () => ({ kind: 'approve-once' });
    const deny = () => ({ kind: 'deny' });

    if (request.kind === 'read') return approve();

    if (request.kind === 'write') {
      const target = request.fileName ?? request.path;
      if (target && !isWithin(workspace, target)) {
        output.appendLine(`Denied write outside workspace: ${target}`);
        return deny();
      }
      if (mode === 'workspace') return approve();
    }

    if (request.kind === 'shell') {
      const command = request.fullCommandText ?? '';
      if (mode === 'workspace' && !riskyCommand(command)) return approve();
    }

    const description = request.kind === 'shell'
      ? request.fullCommandText
      : request.kind === 'write'
        ? `Write ${request.fileName ?? request.path ?? ''}`
        : `${request.kind} permission`;

    const message = `Convergent agent requests permission: ${description}`;
    let choice = typeof options.chatChoice === 'function'
      ? await options.chatChoice({ kind: 'permission', title: 'Permission needed', message, choices: ['Allow once', 'Deny'] })
      : null;
    if (choice === null) choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Allow once', 'Deny');
    return choice === 'Allow once' ? approve() : deny();
  };
}

function createUserInputHandler(vscode, options = {}) {
  return async (request) => {
    if (request.choices?.length) {
      let picked = typeof options.chatChoice === 'function'
        ? await options.chatChoice({ kind: 'clarification', title: 'Clarification needed', message: request.question, choices: request.choices })
        : null;
      if (picked === null) {
        picked = await vscode.window.showQuickPick(request.choices, {
          title: 'Convergent needs clarification',
          placeHolder: request.question,
          ignoreFocusOut: true,
        });
      }
      if (picked !== undefined) return { answer: picked, wasFreeform: false };
      return { answer: 'User cancelled the clarification request.', wasFreeform: true };
    }

    options.announceFreeformQuestion?.(request.question);
    const answer = await vscode.window.showInputBox({
      title: 'Convergent needs clarification',
      prompt: request.question,
      ignoreFocusOut: true,
    });
    if (answer === undefined) return { answer: 'User cancelled the clarification request.', wasFreeform: true };
    return { answer, wasFreeform: true };
  };
}

module.exports = {
  createPermissionHandler,
  createUserInputHandler,
  isWithin,
  riskyCommand,
  sensitiveEnvironmentCommand,
  SENSITIVE_ENV_NAMES,
};
