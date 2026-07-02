-- Template gallery honesty fix (Nina, 2026-07-01, DEEP_AUDIT_PM_FINDINGS.md Top-5
-- Finding #3 / §5, corroborated by DEEP_AUDIT_UX_FINDINGS.md). Re-verified directly
-- against the CURRENT workflowRegistry.ts + every real event producer in the backend
-- (routes/responses.ts, lib/alertEngine.ts, lib/workflowEngine.ts's scheduled sweep,
-- routes/internal-workflows.ts) before acting — confirmed exactly 4 of the 8 seeded
-- templates use a trigger_type with ZERO producer anywhere in the codebase, so they
-- can never fire for any customer, on any plan, ever, regardless of configuration:
--   nps-recovery            -> survey.response_filtered   (no producer)
--   verbatim-escalation     -> crystal.verbatim_escalation (no producer)
--   nps-win-celebration     -> score.nps_rise              (no producer)
--   slow-completion-flag    -> survey.response_received    (no producer)
-- The other 4 (weekly-digest, survey-milestone-kickoff, critical-alert-to-zendesk,
-- anomaly-to-jira) all use trigger types with a real, confirmed producer
-- (time.schedule / survey.milestone / alert.fired / crystal.anomaly_detected) —
-- some under-deliver on a downstream step (missing recipient config etc.), which is
-- a separate, already-tracked gap (§5/6b) and explicitly NOT what `is_functional`
-- encodes. `is_functional` is narrowly "does this template's trigger ever fire" —
-- do not overload it later for "delivers perfectly end-to-end" without renaming.
ALTER TABLE workflow_templates
  ADD COLUMN IF NOT EXISTS is_functional BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE workflow_templates
   SET is_functional = FALSE
 WHERE slug IN ('nps-recovery', 'verbatim-escalation', 'nps-win-celebration', 'slow-completion-flag');
