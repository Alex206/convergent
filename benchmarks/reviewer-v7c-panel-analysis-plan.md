# V7C fixed panel-size analysis plan

This analysis plan is committed while the six H15 single-Luna reviewer repetitions in V7C are still in progress, before their structured reports or artifact are available for scoring.

## Primary measure

Score each of repeats 1–6 independently against the exact historical PR #15 regression mechanism:

> explicit successful required/external validator evidence plus wording that describes the expected missing/error negative case must not be reinterpreted as an unresolved validation blocker.

Adjacent blocker-parser defects are useful findings but do not count as hits on the seeded historical regression.

## Fixed synthetic panel grouping

The production broad-Luna panel semantics are independent reviewers followed by union/deduplication of findings; reviewers do not observe one another. Therefore independent single-reviewer repetitions can be grouped post hoc without changing seeded-recall semantics.

Before results are known, fix these groupings:

- L1 samples: repeats `1`, `2`, `3`, `4`, `5`, `6` individually.
- Synthetic L2 panels: `(1,2)`, `(3,4)`, `(5,6)`.
- Synthetic L3 panels: `(1,2,3)`, `(4,5,6)`.

A synthetic panel detects the seed if any member in its fixed group detects the seed. Do not regroup after seeing results.

## Combination with V7

The prior V7 H15 run contributes six additional broad-Luna individual observations: one from `luna-broad-1`, two from `luna-broad-2`, and three from `luna-broad-3`. Manual scoring against the actual PR #15 fix is 5/6 exact historical-seed hits; the `luna-broad-1` finding about resolved prerequisite wording is a different residual defect and is not counted.

After V7C, report:

1. exact individual hit rate across the 12 broad-Luna H15 observations;
2. the fixed V7C L1/L2/L3 grouped outcomes above;
3. observed cost per V7C single reviewer and additive synthetic L2/L3 cost;
4. the H22 result as a systematic-miss counterexample where reviewer multiplicity did not recover the historical defect;
5. the H23 result as a ceiling case where every individual broad Luna already found the historical defect.

Do not infer independent panel probabilities as if reviewer misses were independent without labeling that as an approximation; H22 demonstrates correlated/systematic blind spots.
