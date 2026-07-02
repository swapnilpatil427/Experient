-- Phase 1 template gallery expansion (Maya Okonkwo, Product Lead — Xperiq Actions).
-- Adds 5 templates beyond the original 3 (nps-recovery, weekly-digest,
-- verbatim-escalation) seeded in 20260603000018_workflows_v2.sql. Every
-- trigger/condition-field/action referenced below exists TODAY in
-- backend/src/lib/workflowRegistry.ts (TRIGGERS / CONDITION_FIELDS / ACTIONS) —
-- none of these are aspirational. See docs/automation-hub/TEMPLATE_GALLERY.md
-- for the "why a CX manager needs this" rationale behind each one.

INSERT INTO workflow_templates (slug, name, description, category, trigger_type, nodes, edges, is_featured)
VALUES
  -- 1. Positive-signal template: NPS Rise. Registry: score.nps_rise trigger,
  -- notify.slack + notify.in_app actions (both live:true).
  ('nps-win-celebration', 'NPS Win Celebration', 'When NPS rises, tell the team so wins get reinforced, not just losses.', 'closed_loop', 'score.nps_rise',
   '[{"id":"t","type":"trigger","trigger":"score.nps_rise"},{"id":"a1","type":"action","action":"notify.slack","config":{"title":"NPS is trending up","body":"NPS rose to {{nps}} on {{title}}. Nice work — share what changed."}},{"id":"a2","type":"action","action":"notify.in_app","config":{"priority":"success","title":"NPS win"}}]',
   '[{"from":"t","to":"a1"},{"from":"a1","to":"a2"}]', TRUE),

  -- 2. Survey Milestone Kickoff. Registry: survey.milestone_reached trigger,
  -- crystal.summarize (stub, safe no-op today) + notify.slack + notify.in_app.
  ('survey-milestone-kickoff', 'Survey Milestone Kickoff', 'When a survey crosses a response milestone, get an early read and tell the team before the survey closes.', 'reporting', 'survey.milestone_reached',
   '[{"id":"t","type":"trigger","trigger":"survey.milestone_reached"},{"id":"a1","type":"action","action":"crystal.summarize"},{"id":"a2","type":"action","action":"notify.slack","config":{"title":"Milestone reached","body":"{{title}} just hit a response milestone. {{crystalSummary}}"}},{"id":"a3","type":"action","action":"notify.in_app","config":{"priority":"info","title":"Survey milestone reached"}}]',
   '[{"from":"t","to":"a1"},{"from":"a1","to":"a2"},{"from":"a2","to":"a3"}]', TRUE),

  -- 3. Slow Completion Friction Flag. Registry: survey.response_received trigger,
  -- completion_time condition field (number, gte op), data.tag_responses +
  -- notify.in_app actions.
  ('slow-completion-flag', 'Slow Completion Flag', 'When a response takes far longer than expected to complete, flag it for UX review before survey fatigue shows up in your completion rate.', 'quality', 'survey.response_received',
   '[{"id":"t","type":"trigger","trigger":"survey.response_received"},{"id":"c","type":"condition","conditions":{"operator":"AND","rules":[{"field":"completion_time","op":"gte","value":900}]}},{"id":"a1","type":"action","action":"data.tag_responses","config":{"tag":"slow-completion"}},{"id":"a2","type":"action","action":"notify.in_app","config":{"priority":"info","title":"Slow completion detected","body":"A response on {{title}} took longer than 15 minutes to complete."}}]',
   '[{"from":"t","to":"c"},{"from":"c","to":"a1"},{"from":"a1","to":"a2"}]', FALSE),

  -- 4. Critical Alert to Zendesk. Registry: alert.fired trigger, severity
  -- condition field (string, eq op), crystal.classify (stub) for message
  -- enrichment, zendesk.create_ticket (env-gated, graceful no-op if
  -- unconfigured) + notify.slack. Condition gates on the real event field
  -- (severity) BEFORE crystal.classify runs — crystal.classify's output vars
  -- (crystalSeverity) are only visible to render()-templated action config,
  -- not to downstream condition nodes (see workflowEngine.ts evaluateConditions
  -- call sites, which read {...ctx.event, ...ctx.event.payload} only).
  ('critical-alert-to-zendesk', 'Critical Alert to Zendesk', 'When a critical-severity alert fires, open a Zendesk ticket automatically instead of hoping someone reads the dashboard.', 'escalation', 'alert.fired',
   '[{"id":"t","type":"trigger","trigger":"alert.fired"},{"id":"c","type":"condition","conditions":{"operator":"AND","rules":[{"field":"severity","op":"eq","value":"critical"}]}},{"id":"a1","type":"action","action":"crystal.classify"},{"id":"a2","type":"action","action":"zendesk.create_ticket","config":{"subject":"Critical alert: {{title}}","description":"{{body}} (Crystal severity: {{crystalSeverity}})","priority":"urgent","tags":["xperiq-alert","critical"]}},{"id":"a3","type":"action","action":"notify.slack","config":{"title":"Critical alert escalated to Zendesk","priority":"critical"}}]',
   '[{"from":"t","to":"c"},{"from":"c","to":"a1"},{"from":"a1","to":"a2"},{"from":"a2","to":"a3"}]', TRUE),

  -- 5. Anomaly to Jira. Registry: crystal.anomaly_detected trigger,
  -- crystal.summarize (stub) + jira.create_issue (env-gated, graceful no-op)
  -- + notify.email actions.
  ('anomaly-to-jira', 'Anomaly to Jira Backlog', 'When Crystal detects a statistical anomaly, open a Jira issue for the owning team instead of letting it sit in an insights feed nobody checks on a Monday.', 'escalation', 'crystal.anomaly_detected',
   '[{"id":"t","type":"trigger","trigger":"crystal.anomaly_detected"},{"id":"a1","type":"action","action":"crystal.summarize"},{"id":"a2","type":"action","action":"jira.create_issue","config":{"summary":"Anomaly detected: {{title}}","description":"{{crystalSummary}}","issueType":"Task"}},{"id":"a3","type":"action","action":"notify.email","config":{"subject":"Anomaly filed to Jira","body":"{{crystalSummary}} A Jira issue was opened for follow-up."}}]',
   '[{"from":"t","to":"a1"},{"from":"a1","to":"a2"},{"from":"a2","to":"a3"}]', FALSE)
ON CONFLICT (slug) DO NOTHING;
