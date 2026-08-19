# Evals

## Criteria

| ID | Criterion | Weight | Threshold |
|----|-----------|--------|-----------|
| E1 | coverage_score is in [0.0, 1.0] | 15 | must pass |
| E2 | Every gap has a suggested_survey with non-empty title and type | 25 | must pass |
| E3 | Severity distribution is sensible — critical gaps <= 3 (not everything is critical) | 20 | >= 0.75 |
| E4 | Summary is present and non-empty (2-3 sentence executive summary) | 15 | must pass |
| E5 | No hallucinated survey types — suggested_survey.type values are standard XM types (nps, csat, ces, pulse, exit_interview, product_feedback, onboarding, engagement, custom) | 25 | >= 0.75 |

## Scoring

Pass threshold: overall score >= 0.75

## Failure Behavior

On failure inject failed criteria. Max 1 retry.
E2 failure: inject "Every gap MUST include a suggested_survey with a non-empty title and type."
E3 failure: inject "Reserve 'critical' severity for gaps that genuinely impair decision-making — no more than 3 per output."
E5 failure: inject "suggested_survey.type MUST be one of: nps, csat, ces, pulse, exit_interview, product_feedback, onboarding, engagement, custom. Do not invent new types."
