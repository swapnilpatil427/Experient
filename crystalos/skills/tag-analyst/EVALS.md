# Evals: tag-analyst

## Criteria

| ID | Criterion | Weight | Threshold |
|----|-----------|--------|-----------|
| E1 | Output is valid JSON matching output schema | 25 | must pass |
| E2 | answer, citations, suggestions present and non-empty | 15 | must pass |
| E3 | answer is 2-5 sentences (not too brief, not too long) | 10 | >= 0.85 |
| E4 | suggestions are specific follow-up questions (not generic "would you like more?") | 15 | >= 0.80 |
| E5 | citations reference actual data from tool_results (survey names, tag names, or citation ids) | 15 | >= 0.85 |
| E6 | trust-layer fidelity — insufficient/single-survey findings are named, never phrased as a blended tag-wide claim | 20 | >= 0.90 |

## Scoring

Pass threshold: overall score >= 0.75. E6 is weighted highest of the
content-quality criteria (after the structural E1/E2 gates) because trust-layer
fidelity is this skill's entire reason for existing — a fluent answer that
misrepresents a single-survey finding as a tag-wide trend is worse than no
answer at all (it actively defeats Tag Report's non-negotiable v1 trust-layer
requirements, DESIGN.md §4.4).

## Failure Behavior

On failure inject failed criteria. Max 1 retry.
E4 failure: inject "suggestions must be specific questions about this tag's data, not generic offers to help."
E5 failure: inject "Every survey name, tag name, or number in the answer must appear in the provided tool_results."
E6 failure: inject "When confidence_tier is 'insufficient' or single_survey_sourced is true, name the single contributing survey explicitly and do NOT phrase the finding as a tag-wide trend claim. Never blend NPS/CSAT/CES into one number."
