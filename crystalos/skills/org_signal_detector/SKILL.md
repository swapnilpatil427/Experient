---
name: org-signal-detector
version: 1.0.0
shared: false
description: |
  Cross-survey, org-level anomaly/opportunity detection for the Org Intelligence
  Dashboard (Command Center). Pure function of an already-assembled org_metrics
  snapshot (org_metrics_weekly/org_metrics_daily + survey_health_summary rollup,
  see crystalos/graphs/org_brief_graph.py::aggregate_org_metrics) — no LLM call,
  no DB I/O of its own. Detects 4 signal types (correlated negative sentiment,
  response velocity collapse, NPS floor breach, bright spot) and hands them to
  detect_org_signals, which writes non-suppressed signals into alert_events
  (source='crystal').
compatibility: |
  Invoked only from crystalos/graphs/org_brief_graph.py's detect_org_signals
  node — not a Crystal-chat-facing skill (no allowed-tools / conversational
  contract). Documented as a skill folder (SKILL.md/EVALS.md/detector.py/
  signal_types.py) per this codebase's skill-folder convention, even though it
  has no LLM prompt of its own.
allowed-tools: none (deterministic Python, no LLM call, no tool_results)
evals: EVALS.md
examples: none — see EVALS.md for concrete input/output fixtures
max_output_tokens: 0
max_retries: 0
timeout_seconds: 5
---

## Context

`OrgSignalDetector.detect(org_metrics)` (in `detector.py`) is a pure function:
given an `org_metrics` dict shaped like `aggregate_org_metrics`'s output, it
returns a `list[OrgSignal]`. It never queries the database and never calls an
LLM — all four checks are deterministic threshold/count comparisons over data
the caller already assembled. This makes it independently unit-testable
without a live Postgres connection or a live model call (see EVALS.md).

## The 4 signals

1. **Correlated negative sentiment** — `>= 3` surveys, after excluding any
   survey below the sample-size floor (`ORG_SIGNAL_MIN_SAMPLE_SIZE`, mirrored
   from `insight_settings.py`'s `custom_analysis_min_n_for_nps` platform
   default), show `sentiment_trend == "declining"` simultaneously. Severity is
   `critical` if all contributing surveys share at least one common tag id,
   `warning` otherwise.
2. **Response velocity collapse** — org-level response velocity (normalized
   0-1 within the fetched weekly history) is `< 0.3` for the current week and
   was `> 0.7` two weeks ago. Severity `warning`.
3. **NPS floor breach** — org `avg_nps < -20` for the current period. Severity
   `critical`.
4. **Bright spot** — `>= 2` surveys (sample-size-eligible) show
   `sentiment_trend == "improving"` AND `nps_wow_delta > 5`. Severity `info`.

## Custom-range suppression

In `period_type == "custom"` mode with `range_days < 7`, Signal 2 and Signal 3
are **suppressed** rather than evaluated — a lookback-based velocity
comparison and a single-point NPS floor check are both statistically
unreliable on a window shorter than a week. A suppressed signal is returned
with `suppressed: true` and an explicit `suppressed_reason`, never silently
omitted and never a fabricated number. `detect_org_signals` (the graph node)
does not write suppressed signals into `alert_events`.

## Output shape (`OrgSignal`, see `signal_types.py`)

```json
{
  "signal_type": "correlated_negative_sentiment | velocity_collapse | nps_floor_breach | bright_spot",
  "severity": "critical | warning | info",
  "title": "string",
  "description": "string",
  "survey_id": "string | null",
  "suppressed": false,
  "suppressed_reason": null,
  "metadata": { "...": "signal-specific supporting fields, e.g. survey_ids, common_tag_ids" }
}
```

## Quality Standards

- Never counts a survey below the sample-size floor toward Signal 1 or Signal 4.
- Never fires Signal 2/3 on a custom range under the 7-day floor — emits a
  suppression marker instead.
- Never fabricates a number in `description` — every number in a signal's
  description/metadata traces directly to a field on the input `org_metrics`.
- Deterministic: the same `org_metrics` input always produces the same output
  (no LLM call, no randomness) — this is what makes EVALS.md's cases exact
  input/output fixtures rather than scored criteria.
