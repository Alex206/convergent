'use strict';

class VscodeWorkflowUi {
  constructor(vscode, stream, output) {
    this.vscode = vscode;
    this.stream = stream;
    this.output = output;
  }

  log(message) {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  phase(name, detail) {
    this.stream.progress(`${name}: ${detail}`);
    this.log(`${name}: ${detail}`);
  }

  plan(plan) {
    const lines = ['### Implementation plan', '', plan.summary, ''];
    plan.tasks.forEach((task, index) => {
      lines.push(`${index + 1}. **${task.title}** — ${task.description}`);
    });
    lines.push('');
    this.stream.markdown(lines.join('\n'));
    this.log(`Plan accepted with ${plan.tasks.length} task(s).`);
  }

  taskStarted(task, index, total) {
    this.stream.markdown(`\n### Task ${index}/${total}: ${task.title}\n`);
    this.stream.progress(`Worker A is implementing ${task.title}`);
    this.log(`Task ${task.id} started: ${task.title}`);
  }

  taskCompleted(task) {
    this.stream.markdown(`✓ **${task.title}** passed worker convergence and strong review.\n`);
    this.log(`Task ${task.id} completed.`);
  }

  passResult(worker, report, changed, revision) {
    const mark = report.verdict === 'clean' ? '✓' : report.verdict === 'blocked' ? '⛔' : '↻';
    const state = changed ? 'changed workspace' : report.verdict;
    this.stream.markdown(`${mark} Worker ${worker}: **${state}** — ${report.summary}\n`);
    this.log(`Worker ${worker}: ${report.verdict}, changed=${changed}, revision=${revision.slice(0, 12)}; ${report.summary}`);
  }

  converged(revision, pass) {
    this.stream.markdown(`✓ Workers A and B both approved revision \`${revision.slice(0, 12)}\` after ${pass} review/fix pass(es).\n`);
    this.log(`Workers converged on ${revision} after ${pass} pass(es).`);
  }

  reviewResult(review, cycle) {
    if (review.verdict === 'clean') {
      this.stream.markdown(`✓ Strong reviewer cycle ${cycle}: **CLEAN** — ${review.summary}\n`);
    } else {
      this.stream.markdown(`⚠ Strong reviewer cycle ${cycle}: **${review.verdict.toUpperCase()}** — ${review.summary}\n`);
      for (const finding of review.findings ?? []) {
        this.stream.markdown(`  - **${finding.severity}** ${finding.title}${finding.file ? ` — \`${finding.file}\`` : ''}\n`);
      }
    }
    this.log(`Strong reviewer cycle ${cycle}: ${review.verdict}; ${review.summary}`);
  }

  agentIntent(agent, intent) {
    if (intent) this.stream.progress(`${agent}: ${intent}`);
    this.log(`${agent} intent: ${intent ?? ''}`);
  }

  agentTool(agent, tool) {
    this.log(`${agent} tool: ${tool}`);
  }

  agentMessage(agent, content) {
    if (content) this.log(`${agent}: ${content}`);
  }

  agentError(agent, message) {
    this.log(`${agent} ERROR: ${message}`);
  }
}

module.exports = { VscodeWorkflowUi };
