'use strict';

const {
  VscodeWorkflowUi,
  formatDuration,
  formatTokenCount,
  compactUsage,
} = require('./vscode-ui');

function compactOneLine(value, max = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function appendManagedOutput(output, agent, detail = {}) {
  const command = String(detail.displayCommand ?? '').trim();
  const stdout = String(detail.stdout ?? '').trimEnd();
  const stderr = String(detail.stderr ?? '').trimEnd();
  const id = String(detail.commandId ?? 'managed-command');
  if (!command && !stdout && !stderr) return;

  output.appendLine('');
  output.appendLine(`[managed command ${id}] ${agent}`);
  if (command) output.appendLine(`command: ${command}`);
  if (detail.cwd) output.appendLine(`cwd: ${detail.cwd}`);
  if (stdout) {
    output.appendLine('[stdout]');
    output.appendLine(stdout);
  }
  if (stderr) {
    output.appendLine('[stderr]');
    output.appendLine(stderr);
  }
  if (detail.stdoutTruncated || detail.stderrTruncated) {
    output.appendLine('[capture truncated by managed command bounds]');
  }
}

class StableVscodeWorkflowUi extends VscodeWorkflowUi {
  agentTool(agent, tool, detail = '') {
    const text = `${agent} tool: ${tool}${detail ? ` — ${compactOneLine(detail, 300)}` : ''}`;
    this.log(text);
    this.audit({ type: 'agent_tool', agent, tool, detail: compactOneLine(detail, 600) });
  }

  agentToolComplete(agent, tool, durationMs, success) {
    const text = `${agent} tool complete: ${tool} · ${formatDuration(durationMs)} · ${success ? 'success' : 'failure'}`;
    this.log(text);
    if (!success) this.stream.progress(`${agent}: ${tool} failed · ${formatDuration(durationMs)}`);
  }

  agentMessage(agent, content) {
    const text = compactOneLine(content, 600);
    if (text) this.log(`${agent}: ${content}`);
  }

  agentUsageEvent(agent, summary) {
    const now = Date.now();
    if (now - this.lastUsageLogAt > 1500) {
      this.log(`${agent} usage checkpoint: ${compactUsage(summary)}`);
      this.lastUsageLogAt = now;
    }
  }

  agentManagedCommandProgress(agent, detail = {}) {
    const id = String(detail.commandId ?? 'managed-command');
    if (detail.phase === 'started') {
      this.managedCommandBytes.set(id, 0);
      this.managedCommandProgressAt.set(id, Date.now());
      const pid = Number.isInteger(detail.pid) ? ` · PID ${detail.pid}` : '';
      const command = compactOneLine(detail.displayCommand, 180);
      this.stream.progress(`${agent}: running command${command ? ` — ${command}` : ''}`);
      this.log(`${agent} managed command ${id} started${pid}${command ? `; command=${command}` : ''}.`);
      return;
    }
    if (detail.phase !== 'output') return;
    const bytes = (this.managedCommandBytes.get(id) ?? 0) + Math.max(0, Number(detail.bytes) || 0);
    this.managedCommandBytes.set(id, bytes);
    const now = Date.now();
    const last = this.managedCommandProgressAt.get(id) ?? 0;
    if (now - last >= 15_000) {
      this.managedCommandProgressAt.set(id, now);
      this.log(`${agent} managed command ${id}: ${formatTokenCount(bytes)}B output observed; latest stream=${detail.stream ?? 'unknown'}.`);
    }
  }

  agentManagedCommandComplete(agent, detail = {}) {
    const id = String(detail.commandId ?? 'managed-command');
    this.managedCommandProgressAt.delete(id);
    this.managedCommandBytes.delete(id);

    const elapsed = formatDuration(detail.elapsedMs ?? 0);
    let outcome;
    if (detail.state === 'completed') {
      outcome = Number.isInteger(detail.exitCode) ? `exit ${detail.exitCode}` : 'completed';
    } else if (detail.state === 'timed_out') {
      outcome = detail.terminationProven === false ? 'timed out · termination unproven' : 'timed out';
    } else if (detail.state === 'cancelled') {
      outcome = detail.terminationProven === false ? 'cancelled · termination unproven' : 'cancelled';
    } else {
      outcome = String(detail.state ?? 'finished').replace(/_/g, ' ');
    }

    const failed = detail.state !== 'completed' || (Number.isInteger(detail.exitCode) && detail.exitCode !== 0);
    const mark = detail.state === 'completed' ? (failed ? '✗' : '✓') : '⚠';
    const command = compactOneLine(detail.displayCommand, 260);
    const cwd = compactOneLine(detail.cwd, 120);
    const cwdText = cwd && cwd !== '.' ? ` · cwd \`${cwd}\`` : '';
    const commandText = command ? ` · \`${command.replace(/`/g, '\\`')}\`` : '';

    this.stream.markdown(`\n${mark} **${agent}** · ${outcome} · ${elapsed}${cwdText}${commandText}\n`);
    if (failed && (detail.stdout || detail.stderr)) {
      this.stream.markdown('_Command output is retained in the Convergent Output channel._\n');
    }

    appendManagedOutput(this.output, agent, detail);
    this.log(`${agent}: managed command ${outcome} · ${elapsed}; id=${id}; detailed stdout/stderr retained in Output.`);
    this.audit({
      type: 'managed_command_chat_summary',
      agent,
      commandId: id,
      state: detail.state,
      exitCode: detail.exitCode,
      elapsedMs: detail.elapsedMs,
      outputInChat: false,
    });
  }

  operatorDialogue(dialogue = {}) {
    const question = String(dialogue.question ?? '').trim();
    const rationale = String(dialogue.rationale ?? '').trim();
    const lines = ['', '### Clarification needed', ''];
    if (rationale) lines.push(rationale, '');
    if (question) lines.push(question, '');
    lines.push('_Reply normally in Chat. Convergent will keep the implementation paused while we clarify this together._', '');
    this.stream.markdown(lines.join('\n'));
    this.log(`Stable Chat operator dialogue awaiting reply: ${compactOneLine(question, 320)}`);
    this.audit({ type: 'operator_chat_dialogue_wait', phase: dialogue.phase ?? 'discuss', question });
  }

  operatorProposal(proposal = {}) {
    const action = String(proposal.action ?? '').trim();
    const rationale = String(proposal.rationale ?? '').trim();
    const guidance = String(proposal.guidance ?? '').trim();
    const lines = ['', '### Proposed next step', '', `**Action:** \`${action}\``];
    if (rationale) lines.push('', rationale);
    if (guidance) lines.push('', '**Guidance that would be passed to the next agent:**', '', guidance);
    lines.push('', '_Nothing has continued yet. Confirm this interpretation, correct it, or ask another question._', '');
    this.stream.markdown(lines.join('\n'));
    this.log(`Stable Chat operator proposal: ${action}; ${compactOneLine(rationale, 320)}`);
    this.audit({ type: 'operator_chat_proposal', action, rationale, guidance });
  }

  operatorAgreement(agreement = {}) {
    const action = String(agreement.action ?? '').trim();
    const rationale = String(agreement.rationale ?? '').trim();
    this.stream.markdown(`\n✓ **Agreement reached:** \`${action}\`${rationale ? ` — ${rationale}` : ''}\n\nContinuing from the saved safe checkpoint with the agreed guidance.\n`);
    this.log(`Operator Chat agreement confirmed: ${action}; ${compactOneLine(rationale, 320)}`);
    this.audit({ type: 'operator_chat_agreement_confirmed', action, rationale });
  }
}

module.exports = {
  StableVscodeWorkflowUi,
  compactOneLine,
  appendManagedOutput,
};
