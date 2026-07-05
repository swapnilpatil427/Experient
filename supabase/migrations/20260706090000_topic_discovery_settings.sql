-- topic_discovery_candidate_threshold + topic_discovery_min_cluster_size
-- (added 2026-07-06, alongside crystalos/lib/insight_settings.py's new resolvers)
--
-- topic_discovery_candidate_threshold: how many unmatched/unassigned responses
-- must accumulate in the topic_candidates buffer before a new topic gets
-- clustered + LLM-named (node_cluster / lib/response_tagging.py). Was a flat
-- platform constant (25, same in every environment); the platform-default floor
-- is now env-tiered (dev 10 / dev-paid 15 / staging 20 / prod 30 —
-- lib/constants.py::TOPIC_DISCOVERY_CANDIDATE_THRESHOLD) and this column lets it
-- also be tuned per survey/org, same as stream_response_threshold.
--
-- Note on the SQL DEFAULT below vs. the env-tiered platform default: a NOT NULL
-- DEFAULT column can only hold one literal value, applied identically regardless
-- of which environment's database it lives in — it cannot itself vary by
-- environment. In practice this only matters for the narrow case of a survey
-- that has never explicitly configured THIS setting but has patched some OTHER
-- setting (which triggers an INSERT that omits unset columns, falling back to
-- the SQL default rather than the application-level env-tiered constant); most
-- surveys never touch settings at all and correctly get the true env-tiered
-- default via the "no row exists" resolver path (lib/insight_settings.py). 25 is
-- chosen as a reasonable single value straddling the dev(10)-prod(30) spread for
-- that edge case. Same acknowledged limitation as stream_response_threshold's
-- own resolver docstring ("cannot distinguish a customer who explicitly set this
-- exact field from one who saved some other field and never touched this one").
--
-- topic_discovery_min_cluster_size: minimum size a candidate cluster must reach
-- before being promoted to a permanent, LLM-named topic — separate knob from the
-- threshold above, which only gates WHEN clustering runs, not how big the
-- resulting cluster has to be. Flat platform default (5, no env variance — a
-- statistical validity floor, not a cost/latency knob), so no default-mismatch
-- tension here.
ALTER TABLE survey_insight_settings
  ADD COLUMN IF NOT EXISTS topic_discovery_candidate_threshold INT NOT NULL DEFAULT 25
    CHECK (topic_discovery_candidate_threshold >= 5 AND topic_discovery_candidate_threshold <= 100),
  ADD COLUMN IF NOT EXISTS topic_discovery_min_cluster_size INT NOT NULL DEFAULT 5
    CHECK (topic_discovery_min_cluster_size >= 2 AND topic_discovery_min_cluster_size <= 20);

ALTER TABLE org_insight_defaults
  ADD COLUMN IF NOT EXISTS topic_discovery_candidate_threshold INT
    CHECK (topic_discovery_candidate_threshold IS NULL
           OR (topic_discovery_candidate_threshold >= 5 AND topic_discovery_candidate_threshold <= 100)),
  ADD COLUMN IF NOT EXISTS topic_discovery_min_cluster_size INT
    CHECK (topic_discovery_min_cluster_size IS NULL
           OR (topic_discovery_min_cluster_size >= 2 AND topic_discovery_min_cluster_size <= 20));
