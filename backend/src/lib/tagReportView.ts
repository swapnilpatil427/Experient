/**
 * Transforms the raw GET /tag-report/:runId query results (a `group_insight_runs`
 * row, its `group_insight_run_sources` rows, and its `group_insights` rows) into
 * the rich per-metric view shape the frontend renders against.
 *
 * Added 2026-07-02 during integration reconciliation: the backend and frontend
 * were built in parallel against DESIGN.md/TRACKER.md, which fully specified the
 * STREAMING event contract (both sides converged on it exactly) but not the GET
 * :runId RESPONSE shape as rigorously — the backend returned raw table rows while
 * the frontend was built against a pre-shaped `TagReportMetricTrack[]` (matching
 * what DESIGN.md's UX spec actually describes rendering: trust bars, warning
 * chips, single-survey-sourced flag, corroboration, per-survey breakdown). This
 * derives that shape here rather than reworking the frontend's already-correct
 * rendering logic.
 */

interface RawGroupInsightRow {
  metric_key: string | null;
  headline: string;
  narrative: string;
  trust_score: string | number | null;
  survey_ids: string[];
  citations_json: unknown;
  metric_json: unknown;
}

interface RawSourceRow {
  survey_id: string;
  survey_title: string | null;
  checkpoint_id: string | null;
  trend_eligible: boolean;
  response_count_at_generation: number;
}

interface RawRun {
  run_mode: string;
  stream_events: unknown;
}

interface RealCitation {
  survey_id: string;
  response_id: string;
  source_insight_id: string;
  quote: string;
  sentiment: string;
  relevance: number;
}

interface ComparabilityWarning {
  scope: string;
  warning_type: string;
  distortion_score: number;
  confidence_tier: string;
  affected_survey_ids: string[];
  // Present on R-T3's metric-scoped checks (question_type_mismatch, scale_mismatch,
  // cadence_mismatch — added 2026-07-03); absent on the mode-specific "survey"-scoped
  // checks (temporal_offset, staleness), which apply regardless of which metric a
  // survey contributes to.
  metric_key?: string;
}

interface TagReportMetricTrackView {
  metric_key: string;
  headline: string;
  narrative: string;
  trust_score: number | null;
  eligible_survey_count: number;
  agreement_count: number | null;
  confidence_tier: string | null;
  merged_delta: number | null;
  direction: string | null;
  single_survey_sourced: boolean;
  single_survey_name?: string;
  warnings: ComparabilityWarning[];
  citations: RealCitation[];
  corroborated_with?: string[];
  survey_breakdown?: Array<{
    survey_id: string;
    survey_title?: string;
    // Approximate, display/sort-order only — the real CrystalOS trust score
    // (statistical confidence from response count) is computed in-memory during
    // generation and is not persisted per-survey anywhere in the schema. This is
    // a monotonic-in-response-count proxy so "highest-trust-first" sorting is
    // still correct even though the exact magnitude won't match CrystalOS's.
    trust_score: number;
    delta: number | null;
    no_comparison_available: boolean;
  }>;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** Monotonic-in-response-count display proxy — see survey_breakdown[].trust_score doc above. */
function approximateTrustScore(responseCount: number): number {
  if (responseCount <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(40 + 15 * Math.log2(responseCount + 1))));
}

function parseJsonMaybe(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v === 'object') return v as Record<string, unknown>;
  try {
    return JSON.parse(String(v));
  } catch {
    return {};
  }
}

function parseArrayMaybe(v: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function buildMetricTracks(
  insights: RawGroupInsightRow[],
  sources: RawSourceRow[],
  run: RawRun,
): TagReportMetricTrackView[] {
  const streamEvents = parseArrayMaybe(run.stream_events);
  const sourcesBySurveyId = new Map(sources.map((s) => [s.survey_id, s]));
  const isCustomRange = run.run_mode === 'custom_range';

  const comparabilityWarnings = streamEvents.filter(
    (e) => e.event === 'comparability_warning'
  ) as unknown as ComparabilityWarning[];
  const corroborationEvents = streamEvents.filter((e) => e.event === 'corroboration_detected');
  const bracketDeltaEvents = streamEvents.filter((e) => e.event === 'bracket_delta_computed');

  return insights
    .filter((row) => row.metric_key)
    .map((row): TagReportMetricTrackView => {
      const metricKey = row.metric_key as string;
      const metricJson = parseJsonMaybe(row.metric_json);
      const eligibleSurveyIds = Array.isArray(row.survey_ids) ? row.survey_ids : [];
      const confidenceTier = (metricJson.confidence_tier as string | undefined) ?? null;
      const singleSurveySourced = confidenceTier === 'insufficient' || eligibleSurveyIds.length === 1;

      // A metric-scoped warning (has metric_key — R-T3's question_type_mismatch/
      // scale_mismatch/cadence_mismatch) must match THIS track's metric_key, not
      // just overlap on survey_id — otherwise a CSAT-only scale mismatch could
      // wrongly render on the NPS card for a survey that contributes to both.
      // Survey-scoped warnings (temporal_offset/staleness, no metric_key) keep
      // the original survey-overlap-only match since they apply to a survey
      // regardless of which metric it's contributing to.
      const warnings = comparabilityWarnings.filter((w) => {
        const surveyOverlap = (w.affected_survey_ids || []).some((sid) => eligibleSurveyIds.includes(sid));
        if (!surveyOverlap) return false;
        return w.metric_key === undefined || w.metric_key === metricKey;
      });

      const corroboratedWith = new Set<string>();
      for (const evt of corroborationEvents) {
        const tracks = (evt.tracks as string[]) || [];
        if (tracks.includes(metricKey)) {
          for (const t of tracks) if (t !== metricKey) corroboratedWith.add(t);
        }
      }

      // Only real, response-level citations (survey_id + response_id present) are
      // exposed here — the checkpoint-only placeholder shape (when CrystalOS found
      // no resolvable per-response citation) has no response_id and would violate
      // the frontend's CitationRef contract if surfaced as a citation.
      const citations = parseArrayMaybe(row.citations_json).filter(
        (c) => typeof c.response_id === 'string'
      ) as unknown as RealCitation[];

      const result: TagReportMetricTrackView = {
        metric_key: metricKey,
        headline: row.headline,
        narrative: row.narrative,
        trust_score: toNum(row.trust_score),
        eligible_survey_count: eligibleSurveyIds.length,
        agreement_count: toNum(metricJson.agreement_count) as number | null,
        confidence_tier: confidenceTier,
        merged_delta: toNum(metricJson.merged_delta),
        direction: (metricJson.direction as string | undefined) ?? null,
        single_survey_sourced: singleSurveySourced,
        warnings,
        citations,
      };

      // Fixed 2026-07-03 (QA finding): this previously only named a survey when
      // eligibleSurveyIds.length === 1 — the trivial R-T2a case — silently
      // failing to name anyone in the general R-T2 case (>=2 eligible surveys,
      // only one actually agreeing on a direction). CrystalOS now persists the
      // real single_survey_id it resolved (covering both cases correctly) in
      // metric_json; use that directly instead of re-deriving a narrower
      // approximation from the eligible-count alone.
      const singleSurveyId = (metricJson.single_survey_id as string | null | undefined) ?? null;
      if (singleSurveySourced && singleSurveyId) {
        result.single_survey_name = sourcesBySurveyId.get(singleSurveyId)?.survey_title ?? undefined;
      }
      if (corroboratedWith.size > 0) {
        result.corroborated_with = Array.from(corroboratedWith);
      }

      if (isCustomRange) {
        result.survey_breakdown = eligibleSurveyIds
          .map((sid) => {
            const source = sourcesBySurveyId.get(sid);
            const deltaEvent = bracketDeltaEvents.find((e) => e.survey_id === sid);
            const deltaField = `${metricKey}_delta`;
            const delta = deltaEvent ? toNum(deltaEvent[deltaField]) : null;
            return {
              survey_id: sid,
              survey_title: source?.survey_title ?? undefined,
              trust_score: approximateTrustScore(source?.response_count_at_generation ?? 0),
              delta,
              no_comparison_available: delta === null,
            };
          })
          .sort((a, b) => b.trust_score - a.trust_score);
      }

      return result;
    });
}

export interface TagReportDisclosure {
  pool_size: number;
  examined_count: number;
  included_count: number;
  backfill_occurred: boolean;
}

export function buildDisclosure(run: RawRun, sources: RawSourceRow[]): TagReportDisclosure {
  const streamEvents = parseArrayMaybe(run.stream_events);
  const batchFetchedEvents = streamEvents.filter((e) => e.event === 'batch_fetched');
  const poolSize = toNum(batchFetchedEvents[0]?.pool_size) ?? 0;
  const examinedSurveyIds = new Set(sources.map((s) => s.survey_id));
  const includedSurveyIds = new Set(sources.filter((s) => s.checkpoint_id).map((s) => s.survey_id));
  return {
    pool_size: poolSize,
    examined_count: examinedSurveyIds.size,
    included_count: includedSurveyIds.size,
    // "Backfill" = the batch-resolution loop had to fetch beyond its first batch
    // because of exclusions (TRACKER.md §2's fetch_next_batch/resolve_and_gate_batch
    // cycle) — directly observable as more than one batch_fetched event.
    backfill_occurred: batchFetchedEvents.length > 1,
  };
}
