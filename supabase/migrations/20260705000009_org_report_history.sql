-- Org Dashboard (Command Center) — org_report_history: read-time UNION ALL of scheduled
-- briefs and completed manual summaries, exposing lineage/comparison fields so a client can
-- tell which rows are comparable without a second fetch per row (Decision 16 item 9's
-- corrected view, adapted to the real column names above).

CREATE OR REPLACE VIEW org_report_history AS
SELECT
  id, org_id, date_range_start, date_range_end,
  'scheduled' AS source,
  generated_at,
  parent_checkpoint_id,
  TRUE AS is_comparable
FROM org_crystal_briefs
UNION ALL
SELECT
  id, org_id, date_range_start, date_range_end,
  'manual' AS source,
  generated_at,
  compared_against_brief_id AS parent_checkpoint_id,
  (compared_against_brief_id IS NOT NULL) AS is_comparable
FROM org_custom_summaries
WHERE status = 'completed';

-- ROLLBACK:
-- DROP VIEW IF EXISTS org_report_history;
