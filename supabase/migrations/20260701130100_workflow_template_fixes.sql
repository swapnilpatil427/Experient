-- Fixes to seeded workflow templates (Nina, 2026-07-01, XM_VERIFICATION_REPORT.md
-- Priorities 1 & 2). Append-only per convention — the original seed migration
-- (20260701090200_workflow_templates_phase1_expansion.sql) is left untouched;
-- this migration patches the two already-seeded rows that were shipped in a
-- now-broken state.
--
-- 1. 'survey-milestone-kickoff': trigger_type + embedded trigger node both said
--    'survey.milestone_reached', which workflowRegistry.ts also used to define.
--    The registry has been renamed to 'survey.milestone' to match the one real
--    producer (routes/responses.ts::maybeEmitResponseMilestone). Without this
--    patch, the seeded template would silently never fire again (same bug it
--    was meant to demonstrate, just relocated from "wrong registry string" to
--    "stale seeded row").
--
-- 2. 'anomaly-to-jira': its notify.email action node has no config.userId, and
--    there is no "org owner"/default-recipient concept anywhere in the schema to
--    substitute one safely at migration time (same gap Kenji/Maya identified —
--    no org-chart/reporting-relationship data model exists). Before this pass,
--    workflowEngine.ts's notify.email case silently papered over this by falling
--    back to ctx.event.userId when config.userId was unset — so this template
--    "worked" only by accident, addressing the email to whatever user happened
--    to be on the crystal.anomaly_detected event (which, per Kenji's finding, may
--    not even carry a meaningful userId for this trigger type). Priority 1's
--    code fix removes that fallback: this action node will now cleanly return
--    status 'skipped'/'no_recipient_configured' instead of guessing. That is the
--    CORRECT behavior for a template shipped without a real recipient — silently
--    guessing was the bug, not this template exposing the gap. No schema/data
--    migration can safely invent a recipient here; flagged in
--    docs/automation-hub/TEMPLATE_GALLERY.md and the tracker as a follow-up: a
--    template author must set config.userId (e.g. to an on-call/eng-lead user)
--    before enabling 'anomaly-to-jira' in an org, same as any other notify.email
--    template node without a default-recipient concept.

UPDATE workflow_templates
   SET trigger_type = 'survey.milestone',
       nodes = REPLACE(nodes::text, 'survey.milestone_reached', 'survey.milestone')::jsonb
 WHERE slug = 'survey-milestone-kickoff';
