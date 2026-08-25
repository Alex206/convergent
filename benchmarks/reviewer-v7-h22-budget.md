# Headless model-call budget review

Review the frozen repository as a production correctness audit. Do not modify or remediate the workspace.

The headless runtime enforces bounded whole-run and per-agent-turn model-call usage while allowing already-paid work to reach a safe structured boundary.

Required behavior:

- Whole-run, per-turn, and chat-request limits must fail closed before unbounded additional inference can occur.
- A model call that has already been counted may finish the tool action it selected; the budget must not corrupt or discard an accepted terminal structured report produced by that call.
- Once a terminal report is accepted at a turn limit, only unnecessary continuation after that report should be stopped. No additional model continuation may be allowed merely because the report succeeded.
- A non-terminal limit hit must stop the turn before another model continuation.
- Any model call observed beyond a hard limit is a run-level breach, not a graceful limit.
- Budget accounting must remain correct under the event sequences the Copilot SDK can emit; correctness must depend on semantic turn state, not incidental callback timing.
- Per-turn state must not leak between independent agent turns, while whole-run accounting remains cumulative.

Inspect the budget state machine, event handling, and relevant regression tests/callers. Use concrete event sequences to falsify assumptions where useful. Return only actionable correctness defects supported by repository evidence; otherwise report CLEAN.
