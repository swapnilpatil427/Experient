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
