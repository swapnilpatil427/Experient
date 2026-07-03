# Examples: workflow-analyst

## Example 1: Straightforward threshold-trigger proposal

**Input**:
```json
{
  "message": "Can you set up an alert to notify our CX Slack channel whenever NPS drops below 30?",
  "org_memory_facts": [],
  "context_state": {
    "decisions": [],
    "data_retrieved": {"topics_loaded": false, "metrics_loaded": true}
  },
  "survey_facts": {
    "survey_id": "srv_acme_nps",
    "response_count": 812,
    "survey_type": "NPS",
    "nps_score": 42,
    "workflow_registry": {
      "triggers": [
        {"type": "score.nps_drop", "category": "Score", "label": "NPS dropped"}
      ],
      "conditionFields": [
        {"field": "nps", "label": "NPS score", "kind": "number"}
      ],
      "conditionOperators": ["lt", "lte", "gt", "gte", "eq"],
      "actions": [
        {"action": "notify.slack", "category": "Notify", "label": "Slack message", "live": true}
      ]
    }
  },
  "tool_results": {
    "get_survey_overview": {"survey_id": "srv_acme_nps", "nps_score": 42, "response_count": 812}
  },
  "last_2_turns": []
}
```

**Tool calls made this turn**: `get_survey_overview` (deterministic context fetch, priority order).

**Output**:
```json
{
  "answer": "I can set that up. Your current NPS is 42, so this workflow would only fire if it drops below 30 — I'll wire it to send a Slack message to your CX channel the moment that happens.",
  "citations": ["score.nps_drop", "nps_score:42"],
  "suggestions": [
    "Should this also create a Jira ticket for the CSM team, or just the Slack ping?",
    "Do you want this scoped to a specific segment, or all NPS responses?"
  ],
  "action_proposals": [
    {
      "type": "create_workflow",
      "title": "Alert CX Slack when NPS drops below 30",
      "description": "Your NPS is currently 42 with 812 responses. This workflow notifies your CX Slack channel the moment NPS drops below 30, so the team can respond before it becomes a trend.",
      "params": {
        "survey_id": "srv_acme_nps",
        "name": "NPS drop alert",
        "description": "Notify CX Slack when NPS drops below 30",
        "trigger_type": "score.nps_drop",
        "nodes": [
          {"id": "trigger-1", "type": "trigger", "trigger": "score.nps_drop"},
          {
            "id": "condition-1",
            "type": "condition",
            "conditions": {"operator": "AND", "rules": [{"field": "nps", "op": "lt", "value": 30}]}
          },
          {
            "id": "action-1",
            "type": "action",
            "action": "notify.slack",
            "config": {"channel": "#cx-alerts"},
            "assumed": true,
            "assumption_note": "Assumed Slack channel #cx-alerts — no channel was specified."
          }
        ],
        "edges": [
          {"from": "trigger-1", "to": "condition-1"},
          {"from": "condition-1", "to": "action-1"}
        ],
        "confidence": 0.82,
        "warnings": ["Assumed Slack channel #cx-alerts — no channel was specified."]
      },
      "priority": "medium",
      "requires_confirmation": true
    }
  ]
}
```

---

## Example 2: REJECTED / lowered-confidence — nonexistent trigger

**Input**:
```json
{
  "message": "Automate a Jira ticket every time someone abandons the survey halfway through.",
  "org_memory_facts": [],
  "context_state": {
    "decisions": [],
    "data_retrieved": {"topics_loaded": false, "metrics_loaded": false}
  },
  "survey_facts": {
    "survey_id": "srv_globex_csat",
    "response_count": 340,
    "survey_type": "CSAT",
    "workflow_registry": {
      "triggers": [
        {"type": "survey.response_received", "category": "Survey", "label": "Response received"},
        {"type": "survey.response_filtered", "category": "Survey", "label": "Filtered response (power trigger)"}
      ],
      "conditionFields": [
        {"field": "completion_time", "label": "Completion time (s)", "kind": "number"}
      ],
      "conditionOperators": ["gt", "lt"],
      "actions": [
        {"action": "jira.create_issue", "category": "Integration", "label": "Create Jira issue", "live": "env"}
      ]
    }
  },
  "tool_results": {
    "get_survey_overview": {"survey_id": "srv_globex_csat", "response_count": 340}
  },
  "last_2_turns": []
}
```

**Output**:
```json
{
  "answer": "There's no 'survey abandoned' trigger in the current automation catalog — the closest real signal is completion time on a filtered response event. I can propose a workflow that fires when a response comes in with an unusually short completion time instead, which is a reasonable proxy, but it isn't a true mid-survey abandonment signal since abandoned (never-submitted) sessions don't generate a response event at all.",
  "citations": ["survey.response_filtered", "completion_time"],
  "suggestions": [
    "Want me to set a completion-time threshold as the proxy condition, or hold off until true abandonment tracking exists?",
    "Should the Jira ticket include the response ID so your team can review the partial submission?"
  ],
  "action_proposals": [
    {
      "type": "create_workflow",
      "title": "Flag unusually fast completions for review",
      "description": "No true 'abandoned mid-survey' trigger exists yet. As a proxy, this fires on a filtered response with a very short completion time, and files a Jira issue for review.",
      "params": {
        "survey_id": "srv_globex_csat",
        "name": "Fast-completion review flag",
        "description": "File a Jira issue when a response completes unusually quickly (abandonment proxy)",
        "trigger_type": "survey.response_filtered",
        "nodes": [
          {"id": "trigger-1", "type": "trigger", "trigger": "survey.response_filtered"},
          {
            "id": "condition-1",
            "type": "condition",
            "conditions": {"operator": "AND", "rules": [{"field": "completion_time", "op": "lt", "value": 10}]}
          },
          {
            "id": "action-1",
            "type": "action",
            "action": "jira.create_issue",
            "config": {},
            "assumed": true,
            "assumption_note": "Assumed a 10-second completion-time threshold and default Jira project — neither was specified, and this is a proxy for abandonment, not a true mid-survey-exit trigger."
          }
        ],
        "edges": [
          {"from": "trigger-1", "to": "condition-1"},
          {"from": "condition-1", "to": "action-1"}
        ],
        "confidence": 0.38,
        "warnings": [
          "No 'survey abandoned' trigger exists in the registry — this uses completion_time as an imperfect proxy.",
          "Assumed a 10-second completion-time threshold and default Jira project — neither was specified."
        ]
      },
      "priority": "low",
      "requires_confirmation": true
    }
  ]
}
```

Note: `confidence` is well below Example 1's because two substitutions had to be made
(trigger proxy + assumed threshold/project) — this mirrors `parse_workflow_nl`'s registry-drift
penalty behavior, applied here at the skill-synthesis layer instead of the NL-parse layer.

---

## Example 3: Question about existing workflow status — graceful "can't answer yet"

**Input**:
```json
{
  "message": "What workflows do I have running on this survey, and did any of them fire this week?",
  "org_memory_facts": [],
  "context_state": {
    "decisions": [],
    "data_retrieved": {"topics_loaded": false, "metrics_loaded": true}
  },
  "survey_facts": {
    "survey_id": "srv_initech_nps",
    "response_count": 1200,
    "survey_type": "NPS",
    "nps_score": 51
  },
  "tool_results": {
    "get_survey_overview": {"survey_id": "srv_initech_nps", "response_count": 1200, "nps_score": 51}
  },
  "last_2_turns": []
}
```

**Output**:
```json
{
  "answer": "I don't have a way to look up your existing workflow configuration or run history from this conversation yet — that data isn't wired into Crystal's tools today. Head to the Workflows page to see what's active on this survey and check each workflow's run history tab for whether it fired this week.",
  "citations": [],
  "suggestions": [
    "Want me to propose a new workflow instead, based on what I can see in this survey's current data?",
    "If you tell me what you expect a workflow to have done, I can sanity-check whether the underlying trigger condition would have been met this week."
  ],
  "action_proposals": []
}
```

---

## Example 4: AI-trigger question — mapping to `new_theme_detected`

**Input**:
```json
{
  "message": "Alert me if a new complaint theme shows up in this survey.",
  "org_memory_facts": [],
  "context_state": {
    "decisions": [],
    "data_retrieved": {"topics_loaded": true, "metrics_loaded": true}
  },
  "survey_facts": {
    "survey_id": "srv_hooli_csat",
    "response_count": 640,
    "survey_type": "CSAT",
    "top_topics": [
      {"label": "Onboarding friction", "volume": 88, "sentiment": -0.61},
      {"label": "Billing clarity", "volume": 40, "sentiment": -0.22}
    ],
    "workflow_registry": {
      "triggers": [
        {"type": "crystal.new_theme_detected", "category": "Crystal", "label": "New theme detected"},
        {"type": "crystal.sentiment_spike", "category": "Crystal", "label": "Sentiment spike detected"},
        {"type": "crystal.anomaly_detected", "category": "Crystal", "label": "Anomaly detected"}
      ],
      "conditionFields": [],
      "conditionOperators": [],
      "actions": [
        {"action": "notify.slack", "category": "Notify", "label": "Slack message", "live": true},
        {"action": "notify.in_app", "category": "Notify", "label": "In-app notification", "live": true}
      ]
    }
  },
  "tool_results": {
    "get_survey_overview": {"survey_id": "srv_hooli_csat", "response_count": 640}
  },
  "last_2_turns": []
}
```

**Output**:
```json
{
  "answer": "That matches the `crystal.new_theme_detected` AI trigger — it fires once per insight-pipeline run when a topic newly reaches a material share of your response volume with net-negative sentiment, not on every individual response. It won't catch a single one-off complaint, only a theme that's becoming a real pattern. I can propose a workflow that fires on this trigger and sends an in-app notification so you see it as soon as the next insight run completes.",
  "citations": ["crystal.new_theme_detected"],
  "suggestions": [
    "Want this to also post to Slack instead of (or in addition to) the in-app notification?",
    "Should critical-severity new themes (very negative sentiment) get a different action than warning-severity ones?"
  ],
  "action_proposals": [
    {
      "type": "create_workflow",
      "title": "Notify on new negative theme detected",
      "description": "No condition fields are needed beyond the trigger itself — this fires whenever Crystal's insight pipeline detects a new, materially-sized, net-negative topic.",
      "params": {
        "survey_id": "srv_hooli_csat",
        "name": "New negative theme alert",
        "description": "In-app notification when a new negative theme is detected",
        "trigger_type": "crystal.new_theme_detected",
        "nodes": [
          {"id": "trigger-1", "type": "trigger", "trigger": "crystal.new_theme_detected"},
          {
            "id": "action-1",
            "type": "action",
            "action": "notify.in_app",
            "config": {},
            "assumed": false,
            "assumption_note": null
          }
        ],
        "edges": [
          {"from": "trigger-1", "to": "action-1"}
        ],
        "confidence": 0.88,
        "warnings": []
      },
      "priority": "medium",
      "requires_confirmation": true
    }
  ]
}
```

---

## Example 5: Builder-context — "what have I built so far?"

**Input** (Wave 15 — `CrystalInput.surface="workflow_builder"` force-selected this skill;
`builder_draft` arrives via `survey_facts`, mirroring the frontend's in-progress draft):
```json
{
  "message": "What have I built so far?",
  "org_memory_facts": [],
  "context_state": {
    "decisions": [],
    "data_retrieved": {"topics_loaded": false, "metrics_loaded": false}
  },
  "survey_facts": {
    "survey_id": "org-wide",
    "response_count": 0,
    "survey_type": "custom",
    "workflow_registry": {
      "triggers": [{"type": "score.nps_drop", "category": "Score", "label": "NPS dropped"}],
      "conditionFields": [{"field": "nps", "label": "NPS score", "kind": "number"}],
      "conditionOperators": ["lt"],
      "actions": [{"action": "notify.slack", "category": "Notify", "label": "Slack message", "live": true}]
    },
    "builder_draft": {
      "mode": "sentence",
      "triggerType": "score.nps_drop",
      "scopeSelection": {"scopeType": "org"},
      "conditionClauses": [{"field": "nps", "op": "lt", "value": "30"}],
      "actions": [{"action": "notify.slack", "label": "Slack message"}],
      "workflowName": "NPS drop alert",
      "isEditMode": false
    }
  },
  "tool_results": {},
  "last_2_turns": []
}
```

**Output**:
```json
{
  "answer": "So far you have: a trigger on NPS dropped, a condition that fires when NPS is below 30, and one action — a Slack message. It's scoped org-wide (not limited to one survey or tag) and not yet saved. Want to add another action, tighten the condition, or scope it to a specific survey?",
  "citations": ["score.nps_drop", "nps", "notify.slack"],
  "suggestions": [
    "Want to also file a Jira ticket when this fires?",
    "Should this be scoped to a specific survey instead of org-wide?"
  ],
  "action_proposals": []
}
```

Note: no `action_proposals` here — this is a pure read of the existing draft, not a request to
change anything, so there's nothing to confirm. Every trigger/condition/action name in the
answer is echoed verbatim from `builder_draft`/`workflow_registry`, never reworded or guessed.

---

## Example 6: Builder-context — additive proposal aware of the existing draft

**Input**: the user already has a Slack action configured (same draft as Example 5) and asks to
add a second action without restating the first.
```json
{
  "message": "Also file a Jira ticket when this fires",
  "org_memory_facts": [],
  "context_state": {
    "decisions": [],
    "data_retrieved": {"topics_loaded": false, "metrics_loaded": false}
  },
  "survey_facts": {
    "survey_id": "org-wide",
    "response_count": 0,
    "survey_type": "custom",
    "workflow_registry": {
      "triggers": [{"type": "score.nps_drop", "category": "Score", "label": "NPS dropped"}],
      "conditionFields": [{"field": "nps", "label": "NPS score", "kind": "number"}],
      "conditionOperators": ["lt"],
      "actions": [
        {"action": "notify.slack", "category": "Notify", "label": "Slack message", "live": true},
        {"action": "jira.create_issue", "category": "Integration", "label": "Create Jira issue", "live": "env"}
      ]
    },
    "builder_draft": {
      "mode": "sentence",
      "triggerType": "score.nps_drop",
      "scopeSelection": {"scopeType": "org"},
      "conditionClauses": [{"field": "nps", "op": "lt", "value": "30"}],
      "actions": [{"action": "notify.slack", "label": "Slack message"}],
      "workflowName": "NPS drop alert",
      "isEditMode": false
    }
  },
  "tool_results": {},
  "last_2_turns": []
}
```

**Output**:
```json
{
  "answer": "Added a Jira ticket action alongside your existing Slack notification — both will fire together when NPS drops below 30.",
  "citations": ["score.nps_drop", "nps", "notify.slack", "jira.create_issue"],
  "suggestions": [
    "Want me to also set a default Jira project, or leave that for you to pick when you save?",
    "Should the Jira ticket only fire for the more severe drops, or every time this trigger fires?"
  ],
  "action_proposals": [
    {
      "type": "create_workflow",
      "title": "NPS drop alert",
      "description": "Your NPS drop alert already had a Slack notification configured — this adds a Jira ticket action alongside it, both firing when NPS drops below 30.",
      "params": {
        "survey_id": "org-wide",
        "name": "NPS drop alert",
        "description": "Notify Slack and file a Jira ticket when NPS drops below 30",
        "trigger_type": "score.nps_drop",
        "nodes": [
          {"id": "trigger-1", "type": "trigger", "trigger": "score.nps_drop"},
          {
            "id": "condition-1",
            "type": "condition",
            "conditions": {"operator": "AND", "rules": [{"field": "nps", "op": "lt", "value": 30}]}
          },
          {
            "id": "action-1",
            "type": "action",
            "action": "notify.slack",
            "config": {},
            "assumed": false,
            "assumption_note": null
          },
          {
            "id": "action-2",
            "type": "action",
            "action": "jira.create_issue",
            "config": {},
            "assumed": true,
            "assumption_note": "No specific Jira project was named — a default project will need to be selected before this can be saved."
          }
        ],
        "edges": [
          {"from": "trigger-1", "to": "condition-1"},
          {"from": "condition-1", "to": "action-1"},
          {"from": "action-1", "to": "action-2"}
        ],
        "confidence": 0.8,
        "warnings": ["No specific Jira project was named — a default project will need to be selected before this can be saved."]
      },
      "priority": "medium",
      "requires_confirmation": true
    }
  ]
}
```

Note: the proposal's `nodes` include BOTH `notify.slack` (already in `builder_draft.actions`)
AND the newly requested `jira.create_issue` — never just the new action in isolation. Dropping
the pre-existing Slack action here would look like Crystal forgot what the user already built, or
worse, silently replaced it. This is the core "aware of the existing draft" behavior the
builder-context injection exists to enable.
