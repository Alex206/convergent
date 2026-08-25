# Headless model-call budget semantics

Review the headless model-call budget and its event-driven turn-limit behavior against these requirements. Treat the repository snapshot as frozen and review the relevant implementation, event handling, and tests across the headless runtime rather than assuming one file contains the whole behavior.

- Per-turn model-call limits are scoped to the active agent turn and reset for a new prompt/turn. Total-run and per-turn accounting remain distinct.
- Reaching the configured per-turn call limit is not itself a run-level failure when the model call at that boundary has already produced an accepted structured completion for that same agent/session. In that case the agent turn ends gracefully and the accepted report remains usable.
- SDK events belonging to one model call are asynchronous observations, not an ordering contract. Equivalent semantic events for the same call/session must produce the same budget outcome whether accounting/usage is observed before or after the structured tool completion.
- An accepted structured report from another agent, another session, or an earlier prompt must never suppress a genuine limit breach in the current turn.
- A non-accepted or unrelated tool completion does not grant a graceful stop. Genuine attempts to continue beyond a capped turn without an accepted structured completion must still be rejected according to the existing budget policy.
- Graceful turn-stop state must not leak into the next agent turn or next prompt.

Focus on observable budget outcomes and event-state transitions. Do not assume current tests cover all valid SDK event orderings.
