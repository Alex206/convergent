# Review architectures

Convergent 0.5 makes the modifying-task review gate selectable so R1/R2/R3 can be exercised in normal VS Code workflows without rebuilding the extension.

## Selecting an architecture

The workspace setting is:

```json
{
  "convergent.reviewArchitecture": "luna-specialized"
}
```

The default is `luna-specialized` (R3).

The easier interactive path is **Convergent: Select Review Architecture** in the VS Code command palette. The command writes the setting at workspace scope. A new workflow reads the current value when it starts. A resumed workflow keeps the architecture stored in its checkpoint, so changing the setting cannot silently change assurance topology halfway through a task.

## R1 · Single Terra

Setting value: `terra-single`

- one persistent independent broad reviewer;
- uses `convergent.models.reviewer`, whose default remains the strong/Terra policy;
- retains the existing 0.4 reviewer/remediation/recovery behavior.

Use R1 when comparing the traditional strong single-reviewer gate against the Luna panels.

## R2 · Broad Luna Panel

Setting value: `luna-broad`

- three independent persistent GPT-5.6 Luna reviewer sessions;
- every reviewer receives the complete production review contract;
- every reviewer is independently responsible for requirements/contracts, adversarial/error paths, state/data-flow, integration/compatibility, security/trust boundaries, concurrency/resources, and test adequacy where relevant;
- findings are unioned and deduplicated before remediation;
- any member reporting `BLOCKED` blocks the panel;
- after remediation all three persistent reviewers inspect the new revision again.

R2 deliberately fails closed if GPT-5.6 Luna is not available from Copilot model discovery. It does not silently substitute `auto` or another model.

## R3 · Specialized Luna Panel

Setting value: `luna-specialized`

R3 has the same three-reviewer/persistence/aggregation semantics as R2, but assigns complementary review priorities:

| Reviewer | Priority |
| --- | --- |
| Contract & integration | explicit/negative requirements, APIs/contracts, compatibility, caller/callee assumptions, test adequacy |
| Adversarial & security | hostile/boundary inputs, error paths, trust/provenance transitions, validation/authorization, fail-open behavior |
| State & resources | state/data flow, aliases/ownership, retries/idempotence, ordering, cleanup/cancellation, concurrency/resource lifetime |

The priorities are **not scope restrictions**. Every R3 reviewer still receives the complete production reviewer contract and must report any material defect it discovers outside its assigned priority.

## Common acceptance semantics

R1, R2, and R3 all plug into the same Convergent execution boundary:

- reviewers are read-only;
- review is bound to the current exact workspace revision;
- reviewer findings return to the existing Worker A remediation path;
- high-risk/full routes still re-establish their required peer-convergence invariant when remediation changes the revision;
- existing managed-command safety, credential provenance, BLOCKED recovery, AI-budget, soft review-cycle, audit, and resume semantics remain authoritative;
- R2/R3 panel members currently execute sequentially to keep repository validation commands deterministic and make architecture comparisons straightforward.

The R1/R2/R3 identifiers are retained because they map directly to the reviewer-architecture experiments. The user-facing names can be changed later without changing the stored architecture semantics.
