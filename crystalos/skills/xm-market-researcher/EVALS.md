# Evals

## Criteria

| ID | Criterion | Weight | Threshold |
|----|-----------|--------|-----------|
| E1 | Output is valid JSON with gap_updates, new_gaps, market_shifts, and competitor_weaknesses arrays | 20 | must pass |
| E2 | Every gap_updates and competitor_weaknesses entry has a non-empty source or evidence field (URL, publication, or specific review count) | 25 | must pass |
| E3 | new_gaps entries are genuinely new — not duplicates of existing GAP-XXX gaps referenced elsewhere in the output | 15 | >= 0.75 |
| E4 | market_shifts contains at least 1 entry with a specific (not vague) implication_for_experient | 15 | >= 0.70 |
| E5 | executive_summary is present and non-empty, and is not purely positive about Experient's competitive position | 15 | >= 0.75 |
| E6 | Effort estimates and urgency classifications are realistic and defensible (e.g. no "1 day" for SOC 2 certification-class work) | 10 | >= 0.70 |

## Scoring

Pass threshold: overall score >= 0.75

## Failure Behavior

On failure inject failed criteria. Max 1 retry.
E2 failure: inject "Every competitor claim MUST cite a source (URL, publication, or quantified review count like '~30 reviews mention X') — no unsourced claims."
E5 failure: inject "This document exists to surface hard truths about Experient's competitive position — a purely positive summary is a failure. Identify at least one genuine gap or risk."
E6 failure: inject "Effort estimates must be realistic — e.g. SOC 2 certification-class work cannot be estimated at '1 day'."
