# Evals

## Criteria

| ID | Criterion | Weight | Threshold |
|----|-----------|--------|-----------|
| E1 | gaps_assessed is a positive integer consistent with the counts of closed, partially_closed, and still_open | 15 | >= 0.80 |
| E2 | Every closed gap has non-empty evidence citing a specific file, migration, or route — never a design doc, plan, or TODO comment | 30 | >= 0.85 |
| E3 | GAP-001 (SOC2), GAP-002 (HIPAA), GAP-003 (FedRAMP) never appear in closed — these require external audit/certification, not just code, and must never be auto-closed for any reason | 30 | must pass |
| E4 | Every partially_closed entry has non-empty what_exists and what_remains | 10 | must pass |
| E5 | summary is present and non-empty, 2-3 sentences on sprint progress vs. the gap inventory | 15 | must pass |

## Scoring

Pass threshold: overall score >= 0.75

## Failure Behavior

On failure inject failed criteria. Max 1 retry.
E2 failure: inject "A gap is only CLOSED when there is a specific file, migration, or route as evidence — a design doc or plan is NOT sufficient evidence."
E3 failure: inject "GAP-001 (SOC2), GAP-002 (HIPAA), and GAP-003 (FedRAMP) require external audits and can NEVER be marked closed by this skill, regardless of code evidence. Re-classify as OPEN or PARTIAL."
E4 failure: inject "Every partially_closed entry MUST include both what_exists and what_remains, non-empty."
