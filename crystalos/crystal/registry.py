"""Crystal tool registry — defines all tools available to the Crystal ReAct loop.

Two categories:
  1. Data tools (read-only) — query DB for insights, topics, metrics, verbatims
  2. Action tools (write-intent) — propose surveys, edits, workflows, distribution.
     Action tools return *proposals* (structured JSON) that the frontend executes
     after user confirmation. Crystal never executes write operations autonomously.
"""
from __future__ import annotations
from typing import Any

# Each tool entry: name, description, input_schema (JSON Schema), scope
TOOL_REGISTRY: list[dict[str, Any]] = [
    {
        "name": "get_survey_overview",
        "description": "Get a high-level overview of a survey including response count, NPS/CSAT scores, and top topics.",
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string", "description": "UUID of the survey"}
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "get_topic_details",
        "description": "Get detailed information about a specific topic including verbatims and sentiment breakdown.",
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "topic_name": {"type": "string", "description": "Name of the topic to deep-dive"},
                "limit": {"type": "integer", "default": 10, "description": "Max verbatims to return"},
            },
            "required": ["survey_id", "topic_name"],
        },
    },
    {
        "name": "get_metric_history",
        "description": "Get time series of NPS/CSAT/CES metrics over time from metric snapshots.",
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "metric": {"type": "string", "enum": ["nps", "csat", "ces", "all"], "default": "all"},
                "days": {"type": "integer", "default": 90, "description": "Lookback window in days"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "get_insights_list",
        "description": "Get the list of AI-generated insights for a survey, optionally filtered by layer or time window.",
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "layer": {"type": "string", "enum": ["descriptive", "diagnostic", "predictive", "prescriptive", "all"], "default": "all"},
                "time_window": {"type": "string", "enum": ["all_time", "last_30d", "last_7d"], "default": "all_time"},
                "limit": {"type": "integer", "default": 20},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "get_verbatims",
        "description": "Retrieve raw response verbatims filtered by topic and/or sentiment.",
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "topic_name": {"type": "string", "description": "Filter by topic (optional)"},
                "sentiment": {"type": "string", "enum": ["positive", "negative", "neutral", "all"], "default": "all"},
                "limit": {"type": "integer", "default": 15},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "get_benchmark_comparison",
        "description": "Compare survey metrics against industry benchmarks.",
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "metric": {"type": "string", "enum": ["nps", "csat", "ces"], "default": "nps"},
                "industry": {"type": "string", "description": "Industry for benchmark (uses org profile if not provided)"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "get_driver_analysis",
        "description": "Get key drivers of NPS/CSAT with impact scores on a -100 to +100 scale.",
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "metric": {"type": "string", "enum": ["nps", "csat"], "default": "nps"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "get_segment_breakdown",
        "description": "Break down responses by a specific question answer to show segment-level differences.",
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "segment_question_id": {"type": "string", "description": "Question ID to segment by"},
                "metric": {"type": "string", "enum": ["nps", "csat", "sentiment"], "default": "sentiment"},
            },
            "required": ["survey_id", "segment_question_id"],
        },
    },
    {
        "name": "list_segmentable_questions",
        "description": (
            "List the survey's questions that can be used to segment responses (choice, scale, "
            "and rating questions), returning each question's id and text. Call this BEFORE "
            "analyze_segments / get_segment_breakdown so you can pick a real segment_question_id."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "get_checkpoint_history",
        "description": "Get the history of insight checkpoints for a survey showing how metrics changed over time.",
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "limit": {"type": "integer", "default": 5},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "get_recent_checkpoints",
        "description": (
            "Get the most recent insight checkpoints for a survey with their NPS, "
            "delta_from_prior (code-computed metric/topic changes), and meaningful_delta "
            "flag. Use to answer 'what changed since the last checkpoint' or to summarize "
            "the recent intelligence trajectory."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "limit": {"type": "integer", "default": 5, "description": "Max checkpoints to return"},
            },
            "required": ["survey_id"],
        },
    },
    # ── Insight Pipeline v2 — checkpoint chain / trail / report tools (Phase 6) ──
    {
        "name": "get_checkpoint_chain",
        "description": (
            "Walk the verified automated checkpoint chain (insight_checkpoints_v2) newest→oldest "
            "via parent_checkpoint_id, returning each node's NPS, nps_delta, new_response_count, "
            "meaningful_delta, a one-line summary and a trail URL. Use to show the intelligence "
            "trajectory ('how has NPS moved over the last N checkpoints'). Verified linked-list "
            "walk — prefer over get_recent_checkpoints when ancestry matters."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "lookback": {"type": "integer", "default": 5, "description": "How many checkpoints back to walk"},
                "lane": {"type": "string", "enum": ["automated", "manual", "all"], "default": "automated"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "get_insight_settings",
        "description": (
            "Return the effective merged insight settings for a survey (3-level COALESCE: "
            "survey → org defaults → platform constants). Use to explain pipeline behavior to the "
            "user, e.g. 'Your survey references 5 prior checkpoints and updates every 10 new responses.'"
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "get_insight_report",
        "description": (
            "Fetch an insight report document (executive summary, themes, insights, citation count) "
            "plus an in-app report URL for a survey. survey_id is required; report_id or checkpoint_id "
            "are optional filters — if neither is given, returns the latest report. Output carries "
            "render_hint='document' so the frontend renders an InsightDocumentCard. Call this before "
            "emitting a report-related action proposal to decide view vs generate."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "report_id": {"type": "string", "description": "Specific insight_reports id (optional)"},
                "checkpoint_id": {"type": "string", "description": "Checkpoint to resolve a report for (optional)"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "get_insight_trail",
        "description": (
            "List the checkpoint/report nodes for a survey (the Insight Trail), newest first, with a "
            "one-line summary, lane (automated/manual), and trail URL per node. Use for 'history', "
            "'timeline', 'show me past reports', or to fuzzy-match a named manual report (lane='manual')."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "lane": {"type": "string", "enum": ["all", "automated", "manual"], "default": "all"},
                "limit": {"type": "integer", "default": 10},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "get_checkpoint_detail",
        "description": (
            "Deep-dive one checkpoint: its metrics, delta_from_prior (what changed), lineage "
            "(parent + prior checkpoint refs), and new-response count. Use for 'what changed since "
            "the last update' on a specific checkpoint."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "checkpoint_id": {"type": "string", "description": "insight_checkpoints_v2 id (or legacy checkpoint id)"},
            },
            "required": ["checkpoint_id"],
        },
    },
    {
        "name": "compare_checkpoints",
        "description": (
            "Side-by-side comparison of two checkpoints — metric deltas (NPS/CSAT/CES) and topic "
            "diff (emerged / resolved between A and B). Use for 'compare checkpoint 12 to 14'."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "checkpoint_id_a": {"type": "string"},
                "checkpoint_id_b": {"type": "string"},
            },
            "required": ["checkpoint_id_a", "checkpoint_id_b"],
        },
    },
    {
        "name": "compare_surveys",
        "description": "Compare two surveys side-by-side on key metrics and themes.",
        "scope": "org",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id_a": {"type": "string"},
                "survey_id_b": {"type": "string"},
                "metrics": {"type": "array", "items": {"type": "string"}, "default": ["nps", "csat"]},
            },
            "required": ["survey_id_a", "survey_id_b"],
        },
    },
    {
        "name": "get_org_portfolio",
        "description": "Get a portfolio summary of all active surveys in the org with aggregate metrics.",
        "scope": "org",
        "input_schema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "default": 10, "description": "Max surveys to include"},
            },
        },
    },
    {
        "name": "get_cross_survey_themes",
        "description": "Identify topics/themes that appear frequently across multiple surveys in the org.",
        "scope": "org",
        "input_schema": {
            "type": "object",
            "properties": {
                "min_survey_count": {"type": "integer", "default": 2, "description": "Min number of surveys a theme must appear in"},
                "limit": {"type": "integer", "default": 10},
            },
        },
    },
    {
        "name": "get_anomaly_events",
        "description": "Get anomalous metric changes flagged by the pipeline across surveys.",
        "scope": "both",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string", "description": "Filter by survey (optional for org scope)"},
                "days": {"type": "integer", "default": 30},
                "limit": {"type": "integer", "default": 10},
            },
        },
    },
    # ── Analytical-skill tools (delegate to CrystalOS analytical skills) ─────────
    # Each fetches the raw data it needs, assembles the skill's input schema, and
    # runs the skill via the skill runtime. Returns structured analysis (not a proposal).
    {
        "name": "summarize_themes",
        "description": (
            "Summarize and explore the qualitative feedback — themes, topics, key takeaways, and "
            "non-quantitative trends (what people are saying and how sentiment is shifting). Use for "
            "open-ended 'what are people saying / give me the gist / what's emerging' questions. "
            "Delegates to the data-explorer skill."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "question": {"type": "string", "description": "The user's exploration request, verbatim, so the right lens is chosen"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "analyze_trends_over_time",
        "description": (
            "Analyze how a metric or themes have moved over time — direction, magnitude, inflection "
            "points, and whether the movement is significant vs noise. Use for 'is X improving/declining', "
            "'what changed in the last N days', 'how is sentiment trending'. Delegates to the trend-analyst skill."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "metric": {"type": "string", "enum": ["nps", "csat", "ces", "sentiment", "all"], "default": "all"},
                "days": {"type": "integer", "default": 90, "description": "Lookback window in days"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "analyze_segments",
        "description": (
            "Analyze how experience differs across segments/cohorts (the 'average trap' detector) — "
            "between-segment gaps, ranking, and where the aggregate hides an underperforming group. "
            "Use for 'how does X differ by segment', 'which group is dragging the score'. "
            "If you don't have a segment_question_id, call list_segmentable_questions first. "
            "Delegates to the segment-analyst skill."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "segment_question_id": {"type": "string", "description": "Question id to segment by (from list_segmentable_questions)"},
                "segment_question_text": {"type": "string", "description": "Question text to segment by, if id is unknown"},
                "metric": {"type": "string", "enum": ["nps", "csat", "sentiment"], "default": "sentiment"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "analyze_key_drivers",
        "description": (
            "Key driver analysis — explain WHY the metric is where it is and where the leverage lives, "
            "via an importance × performance priority map (fix-first / maintain / low-priority / monitor). "
            "Use for 'what's driving our score', 'what should we fix to move the needle'. "
            "Delegates to the driver-analyst skill."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "metric": {"type": "string", "enum": ["nps", "csat", "ces", "enps"], "default": "nps"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "proactive_insights",
        "description": (
            "Surface what changed and what matters right now without a specific question — ranks recent "
            "anomalies, trend movements, driver shifts and segment gaps into a short list of "
            "notification-ready insight cards. Use for 'anything I should know', 'what's important'. "
            "Delegates to the proactive-insights skill."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "generate_report",
        "description": (
            "Generate a complete, export-ready experience report — assembles narrative findings, trends, "
            "drivers, segments and benchmarks into a sectioned document with an executive summary and "
            "action appendix. Use for 'generate a report', 'build the readout', 'give me the full writeup'. "
            "Delegates to the report-composer skill."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id": {"type": "string"},
                "audience": {"type": "string", "enum": ["executive", "operational", "board"], "default": "executive"},
                "length": {"type": "string", "enum": ["brief", "standard", "full"], "default": "standard"},
            },
            "required": ["survey_id"],
        },
    },
    # ── Action tools (propose-only — frontend executes after user confirmation) ──

    {
        "name": "recommend_next_actions",
        "description": (
            "Generate a prioritized list of recommended next actions based on current survey insights, "
            "industry context, top themes, and conversation history. Returns concrete proposals "
            "(create follow-up survey, add questions, distribute to segment, create workflow) "
            "with execution params the user can apply with one click. Use when the user asks "
            "'What should I do?', 'What are my next steps?', or 'How do I act on this?'."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id":  {"type": "string"},
                "focus_area": {"type": "string", "description": "Specific theme or topic to focus recommendations on (optional)"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "propose_survey_creation",
        "description": (
            "Propose a new follow-up or complementary survey based on insights gaps. "
            "Returns a survey creation proposal with intent, type, and suggested questions. "
            "Use when the user wants to dig deeper into a theme, target a specific segment, "
            "or run a follow-up after this survey's results. The proposal must be confirmed by "
            "the user before anything is created."
        ),
        "scope": "both",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id":    {"type": "string", "description": "Source survey for context"},
                "purpose":      {"type": "string", "description": "What should the new survey learn? (plain English)"},
                "target_audience": {"type": "string", "description": "Who to send it to (e.g., 'NPS detractors', 'churned customers')"},
                "survey_type":  {"type": "string", "enum": ["NPS", "CSAT", "CES", "eNPS", "custom"], "default": "custom"},
            },
            "required": ["purpose"],
        },
    },
    {
        "name": "propose_survey_edit",
        "description": (
            "Propose specific edits to the current survey — add questions, improve wording, "
            "add skip logic, or restructure. Returns a list of proposed changes with rationale. "
            "Use when the user wants to improve the survey based on insights, add follow-up "
            "questions for a specific theme, or add conditional branching. Confirms before applying."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id":    {"type": "string"},
                "edit_request": {"type": "string", "description": "What changes to propose (plain English)"},
                "focus_topic":  {"type": "string", "description": "Topic or theme to target with edits (optional)"},
            },
            "required": ["survey_id", "edit_request"],
        },
    },
    {
        "name": "propose_distribution",
        "description": (
            "Propose a targeted distribution strategy — which segment to reach, which channel "
            "to use, and when to send. Returns a distribution proposal with audience filter, "
            "channel, timing, and expected response rate. Use when the user asks about "
            "sending the survey to more people, targeting a specific group, or re-engaging "
            "non-respondents. Confirms before distributing."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id":       {"type": "string"},
                "target_segment":  {"type": "string", "description": "Who to target (e.g., 'NPS detractors', 'churned last 30 days')"},
                "goal":            {"type": "string", "description": "What you want to learn from this send"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "propose_workflow",
        "description": (
            "Propose an automation workflow triggered by survey responses — for example, "
            "alert a CSM when NPS < 7, send a follow-up email after low CSAT, or create a "
            "Jira ticket for high-effort interactions. Returns a workflow proposal with trigger, "
            "condition, and action. Confirms before creating."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id":        {"type": "string"},
                "trigger_condition": {"type": "string", "description": "What response pattern triggers the workflow (e.g., 'NPS score 0-6')"},
                "desired_outcome":  {"type": "string", "description": "What should happen when triggered"},
            },
            "required": ["survey_id", "trigger_condition"],
        },
    },
    {
        "name": "propose_alert",
        "description": (
            "Propose an alert rule so the team is automatically notified when a metric "
            "or topic crosses a risk threshold — e.g. alert when NPS drops below 30, CSAT "
            "falls under 3.5, or a negative topic spikes. Returns an alert proposal the user "
            "confirms before it is created. Use when you spot a risk worth monitoring."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id":  {"type": "string"},
                "metric":     {"type": "string", "description": "Metric or topic to watch (e.g. 'NPS', 'CSAT', 'Wait time sentiment')"},
                "condition":  {"type": "string", "description": "Plain-English trigger (e.g. 'NPS drops below 30')"},
                "alert_type": {"type": "string", "description": "Alert catalog code: S-03 NPS threshold, S-01 NPS drop, S-04 CSAT drop, T-03 topic spike. Default S-03."},
                "severity":   {"type": "string", "enum": ["critical", "warning", "info", "success"]},
                "threshold":  {"type": "object", "description": "Threshold config object, e.g. {\"below\": 30}"},
            },
            "required": ["condition"],
        },
    },
    # ── Insight Pipeline v2 — report action proposals (Phase 6) ─────────────────
    {
        "name": "propose_manual_insight_run",
        "description": (
            "Propose a manual Expert or Quick insight run (deep-dive over a window). Returns a "
            "proposal the user confirms; on confirm the frontend POSTs /api/insights/:surveyId/runs "
            "and streams progress. Use when the user asks for an Expert report or a deep dive."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id":    {"type": "string"},
                "mode":         {"type": "string", "enum": ["manual_expert", "manual_quick"], "default": "manual_expert"},
                "window_start": {"type": "string", "description": "ISO8601 window lower bound (optional)"},
                "window_end":   {"type": "string", "description": "ISO8601 window upper bound (optional)"},
                "label":        {"type": "string", "description": "User-facing label, e.g. 'Q2 board prep'"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "propose_view_report",
        "description": (
            "Propose opening an existing insight report when one exists within the last 7 days "
            "(read-only navigation — no API call). Call get_insight_report first to confirm a recent "
            "report exists, then emit this with its report_id + url."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id":     {"type": "string"},
                "report_id":     {"type": "string"},
                "checkpoint_id": {"type": "string", "description": "Associated checkpoint id, if automated"},
                "url":           {"type": "string", "description": "In-app report viewer URL"},
                "summary":       {"type": "string", "description": "One-line summary for Crystal's prose"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "propose_generate_intelligence_report",
        "description": (
            "Propose generating a fresh intelligence report when no report exists within the last "
            "7 days (or the user explicitly asks to generate one). Returns a proposal showing "
            "estimated_credits; on confirm the frontend POSTs the trigger endpoint and streams progress."
        ),
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "survey_id":         {"type": "string"},
                "estimated_credits": {"type": "integer", "description": "Credit cost shown in the confirm dialog"},
            },
            "required": ["survey_id"],
        },
    },
    {
        "name": "list_relevant_templates",
        "description": (
            "Find survey templates relevant to the current insights or themes. "
            "Returns matching templates from the template library that the user can "
            "use as starting points for follow-up surveys. Use when the user asks "
            "'what template should I use?' or 'do you have a template for X?'."
        ),
        "scope": "both",
        "input_schema": {
            "type": "object",
            "properties": {
                "search_query": {"type": "string", "description": "What kind of survey template to find"},
                "survey_type":  {"type": "string", "enum": ["NPS", "CSAT", "CES", "eNPS", "custom", "any"], "default": "any"},
            },
            "required": ["search_query"],
        },
    },
    # ── User-directory tools (org segmentation) ──────────────────────────────────
    {
        "name": "get_user_directory_context",
        "description": (
            "Get the org's department hierarchy, user groups, and active-user count. "
            "Use this to discover how the organization is structured before segmenting "
            "responses (e.g. 'How does Engineering compare to Sales?')."
        ),
        "scope": "org",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "segment_users_by_attribute",
        "description": (
            "Resolve a segment (a department and its sub-departments, a user group, or a "
            "role) to the list of user_ids in it. Use the returned user_ids to cross-reference "
            "responses by respondent for comparative analysis across org segments."
        ),
        "scope": "org",
        "input_schema": {
            "type": "object",
            "properties": {
                "department_id": {"type": "string", "description": "Department UUID (includes sub-departments)"},
                "department_name": {"type": "string", "description": "Department name (resolved to id)"},
                "group_id": {"type": "string", "description": "User group UUID"},
                "group_name": {"type": "string", "description": "User group name (resolved to id)"},
                "role_key": {"type": "string", "description": "Built-in role key, e.g. org:analyst"},
            },
        },
    },
    # ── Group / Survey-tag tools (cross-survey intelligence) ─────────────────
    {
        "name": "get_group_surveys",
        "description": "List all surveys belonging to one or more tags/groups, with their metadata and response counts.",
        "scope": "group",
        "input_schema": {
            "type": "object",
            "properties": {
                "tag_ids": {"type": "array", "items": {"type": "string"}, "description": "UUIDs of tags"},
            },
            "required": ["tag_ids"],
        },
    },
    {
        "name": "get_group_metrics",
        "description": "Get aggregated NPS/CSAT/CES metrics across all surveys in a group, plus per-survey breakdown.",
        "scope": "group",
        "input_schema": {
            "type": "object",
            "properties": {
                "tag_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["tag_ids"],
        },
    },
    {
        "name": "get_group_topics",
        "description": "Get cross-survey topic landscape: all topics from all surveys in the group with frequency, sentiment, and survey attribution.",
        "scope": "group",
        "input_schema": {
            "type": "object",
            "properties": {
                "tag_ids": {"type": "array", "items": {"type": "string"}},
                "limit": {"type": "integer", "default": 30},
            },
            "required": ["tag_ids"],
        },
    },
    {
        "name": "analyze_group_coverage",
        "description": "Analyze coverage of a survey group: time periods covered, survey types present, segments represented, metric dimensions measured.",
        "scope": "group",
        "input_schema": {
            "type": "object",
            "properties": {
                "tag_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["tag_ids"],
        },
    },
    {
        "name": "detect_data_gaps",
        "description": "Identify what data is missing from a survey group. Detects temporal gaps (missing time periods), survey type gaps, topic semantic gaps, segment gaps, and metric dimension gaps. Returns prioritized gap list with severity.",
        "scope": "group",
        "input_schema": {
            "type": "object",
            "properties": {
                "tag_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["tag_ids"],
        },
    },
    {
        "name": "suggest_new_survey",
        "description": "Propose a new survey to fill a detected gap in a group. Returns a survey creation proposal with title, type, suggested questions, and pre-filled tags.",
        "scope": "group",
        "input_schema": {
            "type": "object",
            "properties": {
                "tag_ids": {"type": "array", "items": {"type": "string"}},
                "gap_description": {"type": "string", "description": "Description of the gap to fill"},
                "gap_type": {"type": "string", "enum": ["temporal", "survey_type", "segment", "metric", "topic"]},
            },
            "required": ["tag_ids", "gap_description", "gap_type"],
        },
    },
    # ── Tag Report tools (cross-survey trust-weighted rollup) ────────────────────
    # See docs/tag-report/DESIGN.md / TRACKER.md. Read-only: these tools read
    # already-generated group_insight_runs/group_insights rows produced by
    # graphs/tag_report.py — they never trigger fresh generation.
    {
        "name": "list_tags",
        "description": (
            "Resolve a tag by name (case-insensitive substring match) or list the org's most "
            "recent tags. Use this to turn a user's reference to a tag ('the onboarding tag', "
            "'exec-dashboard') into a real tag_id before calling get_tag_report or any other "
            "tag/group-scoped tool."
        ),
        "scope": "both",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Name to fuzzy-match against existing tags (optional — omit to list recent tags)"},
                "limit": {"type": "integer", "default": 10, "description": "Max tags to return"},
            },
        },
    },
    {
        "name": "get_tag_report",
        "description": (
            "Fetch a Tag Report — the trust-weighted, cross-survey rollup of per-metric findings "
            "(headline, narrative, trust_score, confidence_tier, single-survey-sourced disclosure, "
            "comparability warnings, citations) for every survey sharing a tag. tag_id is required; "
            "run_id is optional (defaults to the latest completed run for the tag). Output carries "
            "render_hint='document'. Call this before emitting a Tag Report action proposal to "
            "decide view vs generate."
        ),
        "scope": "tag",
        "input_schema": {
            "type": "object",
            "properties": {
                "tag_id": {"type": "string", "description": "UUID of the tag"},
                "run_id": {"type": "string", "description": "Specific group_insight_runs id (optional)"},
            },
            "required": ["tag_id"],
        },
    },
    {
        "name": "get_tag_report_trail",
        "description": (
            "List the Tag Report run history for a tag (the Tag Report Trail), newest first, with "
            "a one-line summary (mode, created_at, headline count) and a trail URL per run. Use for "
            "'history', 'past tag reports', or to find a prior run to compare against."
        ),
        "scope": "tag",
        "input_schema": {
            "type": "object",
            "properties": {
                "tag_id": {"type": "string"},
                "limit": {"type": "integer", "default": 10},
            },
            "required": ["tag_id"],
        },
    },
    {
        "name": "propose_view_tag_report",
        "description": (
            "Propose opening an existing Tag Report (read-only navigation — no API call). Call "
            "get_tag_report first to confirm a report exists, then emit this with its run_id + url."
        ),
        "scope": "tag",
        "input_schema": {
            "type": "object",
            "properties": {
                "tag_id":  {"type": "string"},
                "run_id":  {"type": "string"},
                "url":     {"type": "string", "description": "In-app Tag Report viewer URL"},
                "summary": {"type": "string", "description": "One-line summary for Crystal's prose"},
            },
            "required": ["tag_id"],
        },
    },
    {
        "name": "propose_generate_tag_report",
        "description": (
            "Propose generating a fresh Tag Report when none exists yet, or the user explicitly "
            "asks to regenerate/refresh one. Returns a proposal; on confirm the frontend POSTs the "
            "tag-report trigger endpoint (manual or custom_range mode) and streams progress."
        ),
        "scope": "tag",
        "input_schema": {
            "type": "object",
            "properties": {
                "tag_id":       {"type": "string"},
                "run_mode":     {"type": "string", "enum": ["manual", "custom_range"], "default": "manual"},
                "window_start": {"type": "string", "description": "ISO8601 window lower bound (custom_range only)"},
                "window_end":   {"type": "string", "description": "ISO8601 window upper bound (custom_range only)"},
            },
            "required": ["tag_id"],
        },
    },
    # ── Tier 3 — X+O intelligence tools ─────────────────────────────────────────
    {
        "name": "get_contact_identity",
        "description": "Fetch the contact record linked to a specific survey response. Requires data:pii permission. Returns contact name, email, account, segment attributes, and consent status.",
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "response_id": {"type": "string", "description": "UUID of the response to look up the linked contact for"},
            },
            "required": ["response_id"],
        },
    },
    {
        "name": "get_ownership_route",
        "description": "Resolve a dimension+value pair (e.g. driver='onboarding', account='Acme') to the owner identity via the org's ownership routing rules. Safe for all roles — returns no PII beyond owner label.",
        "scope": "org",
        "input_schema": {
            "type": "object",
            "properties": {
                "dimension": {"type": "string", "description": "The routing dimension, e.g. 'driver', 'account', 'segment', 'region'"},
                "match_value": {"type": "string", "description": "The value to match against routing rules"},
            },
            "required": ["dimension", "match_value"],
        },
    },
    {
        "name": "get_ontology_context",
        "description": "Fetch ontology nodes and edges relevant to a given concept, topic, or signal. Use to understand how X-data signals map to O-data operational concepts (e.g. 'churn risk', 'renewal', 'SLA breach').",
        "scope": "org",
        "input_schema": {
            "type": "object",
            "properties": {
                "concept": {"type": "string", "description": "The concept, signal, or topic to look up in the ontology (e.g. 'detractor', 'churn', 'effort')"},
            },
        },
    },
    {
        "name": "get_xo_context",
        "description": "Cross X-data signals (NPS/sentiment for a segment or account) with O-data ontology mappings to identify convergence risks — accounts or segments where both experience signals AND operational signals indicate risk.",
        "scope": "org",
        "input_schema": {
            "type": "object",
            "properties": {
                "segment": {"type": "string", "description": "Segment name to analyze (e.g. 'enterprise', 'SMB')"},
                "account_id": {"type": "string", "description": "Account ID to analyze (for account-level X+O fusion)"},
                "survey_id": {"type": "string", "description": "Limit X-data to this survey (optional)"},
            },
        },
    },
    {
        "name": "get_case_history",
        "description": "Get the CX case history for a contact or driver. Use to check whether a detractor already has an open case, or whether a recurring driver has been actioned before.",
        "scope": "org",
        "input_schema": {
            "type": "object",
            "properties": {
                "contact_id": {"type": "string", "description": "UUID of the contact to look up cases for"},
                "driver": {"type": "string", "description": "Driver/topic name to look up cases for (e.g. 'onboarding', 'support')"},
            },
        },
    },
    {
        "name": "propose_create_case",
        "description": "Propose creating a CX case for a detractor, high-churn account, or driver finding. Automatically resolves the owner via ownership routing rules. Returns a proposal the user confirms before the case is created.",
        "scope": "survey",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Case title"},
                "description": {"type": "string", "description": "Case description"},
                "contact_id": {"type": "string", "description": "Contact UUID (from get_contact_identity)"},
                "response_id": {"type": "string", "description": "Source response UUID"},
                "severity": {"type": "string", "enum": ["critical", "high", "medium", "low"], "default": "high"},
                "category": {"type": "string", "default": "cx"},
                "driver_ref": {"type": "string", "description": "Driver/topic that triggered the case (for ownership routing)"},
                "account_id": {"type": "string", "description": "Account ID (for ownership routing)"},
                "segment": {"type": "string", "description": "Segment name (for ownership routing)"},
                "priority": {"type": "string", "enum": ["critical", "high", "medium", "low"], "default": "high"},
                "business_rationale": {"type": "string", "description": "Why this case will impact business outcomes"},
                "confidence": {"type": "number", "default": 0.8},
            },
            "required": ["title"],
        },
    },
    {
        "name": "propose_assign_owner",
        "description": "Propose assigning an open CX case to a resolved owner. Use after get_ownership_route identifies the right owner.",
        "scope": "org",
        "input_schema": {
            "type": "object",
            "properties": {
                "case_id": {"type": "string", "description": "UUID of the case to assign"},
                "owner_user_id": {"type": "string", "description": "User ID to assign to"},
                "owner_label": {"type": "string", "description": "Human-readable owner label"},
                "role_label": {"type": "string", "description": "Role label for display"},
                "rationale": {"type": "string", "description": "Why this owner was chosen"},
            },
            "required": ["case_id", "owner_user_id"],
        },
    },
    {
        "name": "propose_slack_alert",
        "description": "Propose sending a Slack alert to a webhook URL. Use to notify a team about a critical case, SLA breach, or convergence risk. The org must have a Slack webhook configured (or the user supplies one).",
        "scope": "org",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Alert notification title"},
                "message": {"type": "string", "description": "Alert message body"},
                "webhook_url": {"type": "string", "description": "Slack webhook URL (org-configured or provided)"},
                "channel": {"type": "string", "description": "Slack channel name", "default": "#cx-alerts"},
                "priority": {"type": "string", "enum": ["critical", "high", "medium", "low"], "default": "medium"},
                "case_id": {"type": "string", "description": "Related case ID (optional)"},
            },
            "required": ["message"],
        },
    },
]


def get_tool_by_name(name: str) -> dict | None:
    """Look up a tool definition by name."""
    return next((t for t in TOOL_REGISTRY if t["name"] == name), None)


def get_tools_for_scope(scope: str) -> list[dict]:
    """Return tools available for a given scope ('survey', 'org', 'group', or 'tag').

    'tag' also includes 'group'-scoped tools (get_group_surveys/metrics/topics/
    analyze_group_coverage etc.) since a single tag IS a survey group — Tag Report's
    tools layer on top of, not instead of, the existing group-scoped tool set.
    """
    if scope == "tag":
        return [t for t in TOOL_REGISTRY if t["scope"] in ("tag", "group", "both")]
    return [
        t for t in TOOL_REGISTRY
        if t["scope"] == scope or t["scope"] == "both"
    ]


# Separate lists for UI categorisation
DATA_TOOL_NAMES = {
    "get_survey_overview", "get_topic_details", "get_metric_history",
    "get_insights_list", "get_verbatims", "get_benchmark_comparison",
    "get_driver_analysis", "get_segment_breakdown", "get_checkpoint_history",
    "get_recent_checkpoints",
    "get_checkpoint_chain", "get_insight_settings", "get_insight_report",
    "get_insight_trail", "get_checkpoint_detail", "compare_checkpoints",
    "list_segmentable_questions",
    "compare_surveys", "get_org_portfolio", "get_cross_survey_themes",
    "get_anomaly_events",
    "get_user_directory_context", "segment_users_by_attribute",
    "get_group_surveys", "get_group_metrics", "get_group_topics",
    "analyze_group_coverage", "detect_data_gaps", "suggest_new_survey",
    "get_contact_identity", "get_ownership_route", "get_ontology_context",
    "get_xo_context", "get_case_history",
    "list_tags", "get_tag_report", "get_tag_report_trail",
}

# Analytical-skill tools — read-only like data tools, but delegate to the skill runtime
# and return structured analysis. Listed separately so the prompt can group them.
ANALYSIS_TOOL_NAMES = {
    "summarize_themes", "analyze_trends_over_time", "analyze_segments",
    "analyze_key_drivers", "proactive_insights", "generate_report",
}

ACTION_TOOL_NAMES = {
    "recommend_next_actions", "propose_survey_creation", "propose_survey_edit",
    "propose_distribution", "propose_workflow", "propose_alert", "list_relevant_templates",
    "propose_create_case", "propose_assign_owner", "propose_slack_alert",
    "propose_manual_insight_run", "propose_view_report",
    "propose_generate_intelligence_report",
    "propose_view_tag_report", "propose_generate_tag_report",
}


def is_action_tool(tool_name: str) -> bool:
    """True when the tool proposes a user-confirming action (vs. read-only data query)."""
    return tool_name in ACTION_TOOL_NAMES


def is_analysis_tool(tool_name: str) -> bool:
    """True when the tool delegates to an analytical skill and returns structured analysis."""
    return tool_name in ANALYSIS_TOOL_NAMES
