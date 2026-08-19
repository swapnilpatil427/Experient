-- Funnel-integrity fix (assistant-ui migration P0 blocker — MIGRATION_PLAN.md §4
-- item 4 / §6, MIGRATION_TEST_PLAN.md §4.1 item (e)).
--
-- The original unique index on crystal_action_proposals omitted survey_id, so the
-- client-minted, title-derived proposal_key (crystalos/agents/crystal.py's slug
-- generator — there is no true per-emission id yet) collapsed ACROSS surveys
-- within one org: two different surveys both proposing "Improve onboarding
-- survey" wrote to the SAME row, and whichever POST landed last silently
-- overwrote the other survey's outcome. Widening the key to (org_id, survey_id,
-- proposal_key) scopes idempotency to "the same proposal on the same survey",
-- which is what the upsert always intended.
--
-- The companion route fix (backend/src/routes/insights.ts, POST
-- /:surveyId/crystal/proposals) changes its ON CONFLICT target to match this
-- index exactly — the two must stay in lockstep or every insert 23505s.
--
-- NOTE: per project convention, migrations here are written/reviewed but not run
-- against any live database as part of this change — schema claims are derived
-- from migration files, not observed DB state.

DROP INDEX IF EXISTS crystal_action_proposals_org_key_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS crystal_action_proposals_org_survey_key_uniq
    ON crystal_action_proposals (org_id, survey_id, proposal_key)
    WHERE proposal_key IS NOT NULL;

COMMENT ON COLUMN crystal_action_proposals.proposal_key IS 'Client-side proposal id used as the idempotency key for upserts (unique per org+survey — still a title-derived slug, not a true per-emission id; see MIGRATION_PLAN.md §6)';

-- ROLLBACK:
-- DROP INDEX IF EXISTS crystal_action_proposals_org_survey_key_uniq;
-- CREATE UNIQUE INDEX IF NOT EXISTS crystal_action_proposals_org_key_uniq
--     ON crystal_action_proposals (org_id, proposal_key)
--     WHERE proposal_key IS NOT NULL;
