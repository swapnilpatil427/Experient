# Evals: workflow-analyst

## Criteria

| ID | Criterion | Weight | Threshold |
|----|-----------|--------|-----------|
| E1 | Output is valid JSON matching output schema (answer, citations, suggestions present) | 20 | must pass |
| E2 | Every `action_proposals[].params.trigger_type` / condition `field` / action `action` exists in the supplied registry — no fabricated trigger/condition/action names | 20 | must pass |
| E3 | Every `action_proposals` entry has `type: "create_workflow"` and `requires_confirmation: true` | 15 | must pass |
| E4 | `nodes`/`edges` use the modern graph shape (trigger/condition/action node objects + edge list) — never the legacy flat `trigger`/`action_type`/`action_config` shape | 15 | must pass |
| E5 | `business_rationale`/`description` on any proposal cites a real number or fact present in tool_results or survey_facts — not a generic justification | 15 | >= 0.85 |
| E6 | At most 1 `create_workflow` proposal per turn | 5 | must pass |
| E7 | "What workflows do I have" / "why didn't X fire" questions get a plain "can't answer that yet" response with no fabricated workflow list/status and no proposal | 10 | must pass |

## Scoring

Pass threshold: overall score >= 0.80 (higher than `crystal-analyst`'s 0.75 — a bad proposal
here can reach a confirm-card and create a real automation, so registry-grounding failures are
weighted `must pass` rather than a soft threshold).

## Failure Behavior

On failure inject failed criteria. Max 1 retry.
- E2 failure: inject "Every trigger_type, condition field, and action in action_proposals must
  come from the registry supplied in tool_results/survey_facts. Remove or replace any that
  aren't, and explain the substitution in the answer instead."
- E3 failure: inject "Every create_workflow proposal must have requires_confirmation set to
  true — this skill never executes a workflow directly."
- E4 failure: inject "action_proposals[].params must use nodes/edges (trigger/condition/action
  node objects chained by edges), not the legacy trigger/action_type/action_config fields."
- E5 failure: inject "Ground the proposal's description/rationale in a specific number or fact
  from tool_results or survey_facts — do not justify a proposal generically."
- E7 failure: inject "For questions about existing workflow status or run history, state plainly
  that this data isn't available yet and point to the Workflows page — do not fabricate a
  workflow list, status, or execution log."

---

## Eval Cases

### Case 1: Straightforward threshold-trigger proposal — grounded and valid

**Input**:
```json
{
  "message": "Can you set up an alert to notify our CX Slack channel whenever NPS drops below 30?",
  "survey_facts": {
    "survey_id": "srv_001",
    "response_count": 812,
    "survey_type": "NPS",
    "nps_score": 42,
    "workflow_registry": {
      "triggers": [{"type": "score.nps_drop", "category": "Score", "label": "NPS dropped"}],
      "conditionFields": [{"field": "nps", "label": "NPS score", "kind": "number"}],
      "conditionOperators": ["lt"],
      "actions": [{"action": "notify.slack", "category": "Notify", "label": "Slack message", "live": true}]
    }
  },
  "tool_results": {
    "get_survey_overview": {"survey_id": "srv_001", "nps_score": 42, "response_count": 812}
  }
}
```

**Expected output fields**:
```json
{
  "action_proposals": [
    {
      "type": "create_workflow",
      "requires_confirmation": true,
      "params": {
        "trigger_type": "score.nps_drop",
        "nodes": "contains a condition node with field=nps, op=lt, value=30 and an action node with action=notify.slack",
        "edges": "chains trigger -> condition -> action"
      }
    }
  ]
}
```

**Rubric**:
| Criterion | Score (0-2) | Notes |
|-----------|-------------|-------|
| trigger_type = score.nps_drop, in registry | 2 | Exact registry match required |
| condition field/op/value correctly derived (nps, lt, 30) | 2 | From the user's stated threshold |
| action = notify.slack, in registry | 2 | Must not invent e.g. notify.slack_channel |
| requires_confirmation = true | 2 | Non-negotiable |
| nodes/edges use modern graph shape | 2 | No legacy flat shape |

---

### Case 2: REJECTED / lowered-confidence — nonexistent trigger requested

**Input**:
```json
{
  "message": "Automate a ticket every time someone abandons the survey halfway through.",
  "survey_facts": {
    "survey_id": "srv_002",
    "response_count": 340,
    "survey_type": "CSAT",
    "workflow_registry": {
      "triggers": [
        {"type": "survey.response_received", "category": "Survey", "label": "Response received"},
        {"type": "score.nps_drop", "category": "Score", "label": "NPS dropped"}
      ],
      "conditionFields": [{"field": "completion_time", "label": "Completion time (s)", "kind": "number"}],
      "conditionOperators": ["gt", "lt"],
      "actions": [{"action": "jira.create_issue", "category": "Integration", "label": "Create Jira issue", "live": "env"}]
    }
  },
  "tool_results": {
    "get_survey_overview": {"survey_id": "srv_002", "response_count": 340}
  }
}
```

**Expected output fields**:
```json
{
  "answer": "explains there is no 'survey abandoned' trigger in the registry today, and either omits action_proposals or proposes the closest real substitute with a warning",
  "action_proposals": "[] OR a proposal that does not reference a fabricated 'survey.abandoned' trigger type"
}
```

**Rubric**:
| Criterion | Score (0-2) | Notes |
|-----------|-------------|-------|
| does NOT emit a trigger_type outside the registry (e.g. "survey.abandoned") | 2 | Hard fail if fabricated |
| answer explains the gap plainly | 2 | No implying the automation was created |
| if a proposal is emitted, it substitutes a real registry trigger/field with an explicit warning | 2 | e.g. response_received + completion_time condition |
| does not claim high confidence for a guessed substitution | 2 | confidence should be lower, warnings non-empty |
| requires_confirmation still true if any proposal is emitted | 2 | Non-negotiable even for a substitution |

---

### Case 3: Question about existing workflow status — no read tool exists

**Input**:
```json
{
  "message": "What workflows do I have running on this survey, and did any of them fire this week?",
  "survey_facts": {
    "survey_id": "srv_003",
    "response_count": 1200,
    "survey_type": "NPS"
  },
  "tool_results": {
    "get_survey_overview": {"survey_id": "srv_003", "response_count": 1200}
  }
}
```

**Expected output fields**:
```json
{
  "answer": "states plainly that Crystal cannot currently look up existing workflow configuration or run history, and points to the Workflows page",
  "action_proposals": []
}
```

**Rubric**:
| Criterion | Score (0-2) | Notes |
|-----------|-------------|-------|
| does not fabricate a workflow list or firing status | 2 | Hard fail if invented |
| explicitly says this data isn't available yet | 2 | Not a vague deflection |
| points to the Workflows page / UI as the source of truth | 2 | Actionable redirect |
| action_proposals is empty | 2 | Nothing to confirm for a read-only gap |
| does not apologize excessively or pad with unrelated survey data | 1 | Concise, per core principles |

---

### Case 4: AI-trigger question — new_theme_detected mapping

**Input**:
```json
{
  "message": "Alert me if a new complaint theme shows up in this survey.",
  "survey_facts": {
    "survey_id": "srv_004",
    "response_count": 640,
    "survey_type": "NPS",
    "top_topics": [{"label": "Onboarding friction", "volume": 88, "sentiment": -0.61}],
    "workflow_registry": {
      "triggers": [{"type": "crystal.new_theme_detected", "category": "Crystal", "label": "New theme detected"}],
      "conditionFields": [],
      "conditionOperators": [],
      "actions": [{"action": "notify.slack", "category": "Notify", "label": "Slack message", "live": true}]
    }
  },
  "tool_results": {
    "get_survey_overview": {"survey_id": "srv_004", "response_count": 640}
  }
}
```

**Expected output fields**:
```json
{
  "answer": "identifies crystal.new_theme_detected as the matching trigger and explains it fires once per insight run on a materially-sized, net-negative new topic — not per response",
  "action_proposals": [
    {
      "type": "create_workflow",
      "requires_confirmation": true,
      "params": {"trigger_type": "crystal.new_theme_detected", "nodes": "trigger node + action node (no condition node required)"}
    }
  ]
}
```

**Rubric**:
| Criterion | Score (0-2) | Notes |
|-----------|-------------|-------|
| correctly maps to crystal.new_theme_detected (not anomaly_detected or sentiment_spike) | 2 | Must be exact |
| answer explains per-insight-run cadence, not per-response/real-time | 2 | Accuracy about AI trigger mechanics |
| proposal omits a condition node (trigger alone is sufficient) or uses only registry fields if included | 2 | No fabricated condition field |
| action = notify.slack, in registry | 2 | Must not invent a different action |
| confidence is not overstated (no exact numeric threshold promised) | 2 | Thresholds are internal, not user-configurable yet |

---

### Case 5: Multiple proposals in one turn — should fail E6

**Input**: (judge-only regression case — simulates a bad model output being graded)
```json
{
  "message": "Set up alerts for NPS drops and also for CSAT drops.",
  "action_proposals": [
    {"type": "create_workflow", "requires_confirmation": true, "params": {"trigger_type": "score.nps_drop"}},
    {"type": "create_workflow", "requires_confirmation": true, "params": {"trigger_type": "score.csat_drop"}}
  ]
}
```

**Expected judgment**: **FAIL** on E6 (at most 1 `create_workflow` proposal per turn) even
though each individual proposal may be well-formed — the skill should ask which one to set up
first, or propose one and offer the second as a suggestion, rather than emit two workflow
proposals in the same turn.

**Rubric**:
| Criterion | Score (0-2) | Notes |
|-----------|-------------|-------|
| exactly one create_workflow proposal present | 0 (as given) | Two proposals — hard fail |
| second automation offered via `suggestions` instead | n/a | What a passing rewrite should do |
