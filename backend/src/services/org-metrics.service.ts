/**
 * OrgMetricsService — data layer for the Org Intelligence Dashboard (Command Center).
 *
 * Reads only from the fixed, ground-truth schema documented in
 * docs/org-dashboard/IMPLEMENTATION_SPEC.md (which wins over ARCHITECTURE.md wherever
 * they conflict — see that doc's header), cross-checked against the real migrations a
 * parallel Data Engineer pass landed (supabase/migrations/20260705000001-000012) and the
 * real frontend contract a parallel Frontend pass already built against
 * (app/src/types/orgDashboard.ts, app/src/lib/api.ts, app/src/hooks/useOrg*.ts). In
 * particular:
 *   - `survey_health_summary.tag_ids`/`tag_names` are arrays (a survey has 0-5 tags via
 *     `survey_tag_mappings`) — there is no singular `tag_group_id`. `ProgramRow.tags`
 *     replaces ARCHITECTURE.md's `tagGroupId`/`tagGroupName` pair (Decision 23).
 *   - Anomaly alerts are `alert_events` rows (Decision 23) — no `survey_anomalies` table.
 *   - Real tables are `surveys`/`responses` (not `survey_responses`).
 *   - `survey_health_summary.response_velocity_7d` is a raw 7-day response COUNT (per
 *     the real migration), not a ratio — used directly as `responses7d`. `velocityScore`
 *     (frontend's `// 0-3x` field) is a separate current-vs-prior-7-day ratio computed
 *     live (see `fetchVelocityScores`), since no such ratio is pre-aggregated anywhere.
 *
 * Caching: Redis, stale-while-revalidate per docs/org-dashboard/ARCHITECTURE.md's TTL
 * table. Every cached read returns a `dataFreshnessAt` timestamp; a request is NEVER
 * blocked waiting for a refresh — a background refresh is kicked off once the cached
 * value is within 20% of its TTL, and the still-cached value is served in the meantime.
 *
 * Documented gaps (real schema limitations, not fabricated — see the PR report for the
 * full list):
 *   - `org_health_score` is UNIQUE(org_id) — a single current snapshot, not a time
 *     series. `getHealthScore()`'s `history` is therefore always `[]` until a real
 *     history table exists (Data Engineer scope, not this pass).
 *   - `org_custom_summaries` has no `label` or `run_id` column in the shipped migration
 *     — `OrgSummary.label`/`.runId` are `null` on list/detail reads (only the CREATE
 *     response, where `runId` is freshly minted, carries a real value). Stuffing these
 *     into `input_snapshot` was considered and rejected: CrystalOS's own `verify_and_score`
 *     step overwrites `input_snapshot` with the real metrics snapshot on completion,
 *     which would silently erase them.
 */
import { query } from '../lib/db';
import { getRedisClient } from '../lib/redis';
import logger from '../lib/logger';

// ── Cache helper (stale-while-revalidate) ────────────────────────────────────────

interface CacheEnvelope<T> {
  value: T;
  cachedAt: number; // epoch ms
}

export interface Cached<T> {
  value: T;
  dataFreshnessAt: string; // ISO timestamp of when `value` was computed
  fromCache: boolean;
}

const inFlightRefresh = new Set<string>();

/** Kicks a background recompute+repopulate for `key`; de-duped per key, never awaited by callers. */
function refreshInBackground<T>(key: string, ttlSec: number, fetcher: () => Promise<T>): void {
  if (inFlightRefresh.has(key)) return;
  inFlightRefresh.add(key);
  (async () => {
    try {
      const value = await fetcher();
      const redis = getRedisClient();
      if (redis && redis.status === 'ready') {
        const envelope: CacheEnvelope<T> = { value, cachedAt: Date.now() };
        await redis.set(key, JSON.stringify(envelope), 'EX', ttlSec);
      }
    } catch (err: unknown) {
      logger.warn({ err: (err as Error).message, key }, 'org-metrics:background_refresh_failed');
    } finally {
      inFlightRefresh.delete(key);
    }
  })();
}

/**
 * Read-through cache: serve the cached value immediately (never block on a refresh).
 * If the cached value is within 20% of TTL expiry, trigger an async background refresh.
 * Fails open to a live fetch when Redis is unavailable.
 */
async function cachedFetch<T>(key: string, ttlSec: number, fetcher: () => Promise<T>): Promise<Cached<T>> {
  const redis = getRedisClient();
  if (redis && redis.status === 'ready') {
    try {
      const raw = await redis.get(key);
      if (raw) {
        const envelope = JSON.parse(raw) as CacheEnvelope<T>;
        const ageSec = (Date.now() - envelope.cachedAt) / 1000;
        if (ageSec >= ttlSec * 0.8) refreshInBackground(key, ttlSec, fetcher);
        return { value: envelope.value, dataFreshnessAt: new Date(envelope.cachedAt).toISOString(), fromCache: true };
      }
    } catch (err: unknown) {
      logger.warn({ err: (err as Error).message, key }, 'org-metrics:cache_read_failed');
    }
  }
  const value = await fetcher();
  const cachedAt = Date.now();
  if (redis && redis.status === 'ready') {
    const envelope: CacheEnvelope<T> = { value, cachedAt };
    redis.set(key, JSON.stringify(envelope), 'EX', ttlSec).catch(() => {});
  }
  return { value, dataFreshnessAt: new Date(cachedAt).toISOString(), fromCache: false };
}

async function invalidate(key: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status !== 'ready') return;
  await redis.del(key).catch(() => {});
}

// ── Shared numeric helpers ────────────────────────────────────────────────────────

function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// Small, non-zero threshold to avoid noisy 'improving'/'declining' flips on rounding
// dust — org_metrics_weekly has no trend enum of its own (only raw *_wow_delta columns),
// so this classification is a judgment call, mirrored from survey_health_summary's own
// improving/stable/declining vocabulary for consistency across the platform.
const SENTIMENT_TREND_EPSILON = 0.02;
function classifySentimentTrend(delta: number | null): 'improving' | 'stable' | 'declining' {
  if (delta == null) return 'stable';
  if (delta > SENTIMENT_TREND_EPSILON) return 'improving';
  if (delta < -SENTIMENT_TREND_EPSILON) return 'declining';
  return 'stable';
}

// ── Types ─────────────────────────────────────────────────────────────────────────

export interface DashboardPayload {
  org: { id: string; name: string };
  healthScore: {
    total: number;
    components: { nps: number; sentiment: number; velocity: number; anomalyFree: number };
    computedAt: string | null;
  } | null;
  kpis: {
    activeSurveys: number;
    totalResponses: number;
    responsesToday: number;
    avgNps: number;
    npsWowDelta: number;
    avgSentiment: number;
    sentimentTrend: 'improving' | 'stable' | 'declining';
  };
  crystalBrief: CrystalBriefSummary | null;
  // NOTE: no dataFreshnessAt field here — the route layer takes it from the generic
  // cache envelope's `Cached<T>.dataFreshnessAt` (the time this payload was actually
  // computed), which is also what every other cached() method on this service relies
  // on. Computing a second, matview-refresh-derived freshness timestamp here would
  // silently diverge from — and always be overwritten by — that wrapper-level value.
}

export type TrustVerdict = 'pass' | 'flag' | 'fail';

export interface CrystalBriefRecommendation {
  rank: number;
  action: string;
  rationale: string;
  surveyId: string | null;
  tagId: string | null;
  actionType: 'investigate' | 'review' | 'celebrate' | 'monitor';
  sourceInsightIds: string[];
}

export interface CrystalBriefSummary {
  id: string;
  briefText: string;
  recommendations: CrystalBriefRecommendation[];
  generatedAt: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  // Progressive-disclosure trust fields (app/src/types/orgDashboard.ts's `CrystalBrief`;
  // Decision 16 items 6/9) — optional/nullable because the trust pass runs
  // post-publish and may not have completed yet.
  trustVerdict: TrustVerdict | null;
  trustScore: number | null; // 0-100 (scaled from hallucination_score's 0-1 NUMERIC(5,4))
  parentCheckpointId: string | null;
}

/**
 * `org_brief_graph.py::_make_rec` writes recommendation objects into the
 * `recommendations` JSONB column with raw Python/SQL-native snake_case keys
 * (`survey_id`, `tag_id`, `action_type`, `source_insight_ids`). The frontend's
 * `CrystalBriefRecommendation` type (app/src/types/orgDashboard.ts) declares
 * camelCase fields. Nothing upstream transforms one into the other — without
 * this mapper, every recommendation's `surveyId`/`tagId`/`actionType`/
 * `sourceInsightIds` would be `undefined` at runtime on the frontend, silently
 * breaking the drill-down links and action-type icons. This is the single
 * place that resolves it. Also resolves the `tag_group_id` (IMPLEMENTATION_SPEC.md's
 * ground truth) vs. `tag_id` (the actual migration's shape comment) naming
 * ambiguity CrystalOS flagged — `org_brief_graph.py` emits both, always null
 * today; `tagId` is the canonical field per Decision 23 (a "tag group" is a
 * `survey_tags` row, so its id is `tag_id`, not `tag_group_id`).
 */
function mapRecommendation(raw: unknown): CrystalBriefRecommendation {
  const r = (raw ?? {}) as Record<string, unknown>;
  const actionType = r.action_type ?? r.actionType;
  return {
    rank: Number(r.rank) || 0,
    action: (r.action as string) ?? '',
    rationale: (r.rationale as string) ?? '',
    surveyId: ((r.survey_id ?? r.surveyId) as string | undefined) ?? null,
    tagId: ((r.tag_id ?? r.tagId ?? r.tag_group_id ?? r.tagGroupId) as string | undefined) ?? null,
    actionType: (actionType as CrystalBriefRecommendation['actionType']) ?? 'monitor',
    sourceInsightIds: Array.isArray(r.source_insight_ids ?? r.sourceInsightIds)
      ? (r.source_insight_ids ?? r.sourceInsightIds) as string[]
      : [],
  };
}

/**
 * Maps a raw org_crystal_briefs (or org_custom_summaries) row to the shared
 * CrystalBriefSummary shape the frontend's `CrystalBrief` type expects everywhere a
 * brief is returned (dashboard payload + dedicated crystal-brief endpoint).
 */
function mapCrystalBriefRow(row: Record<string, unknown>): CrystalBriefSummary {
  const trustJson = row.trust_json as Record<string, unknown> | null | undefined;
  const hallucinationScore = numOrNull(row.hallucination_score);
  const verdict = trustJson?.verdict;
  return {
    id: row.id as string,
    briefText: row.brief_text as string,
    recommendations: Array.isArray(row.recommendations) ? (row.recommendations as unknown[]).map(mapRecommendation) : [],
    generatedAt: row.generated_at as string,
    dateRangeStart: row.date_range_start as string,
    dateRangeEnd: row.date_range_end as string,
    trustVerdict: verdict === 'pass' || verdict === 'flag' || verdict === 'fail' ? verdict : null,
    trustScore: hallucinationScore != null ? Math.round(hallucinationScore * 100) : null,
    parentCheckpointId: (row.parent_checkpoint_id as string | undefined) ?? null,
  };
}

export interface ProgramTag { id: string; name: string; color: string | null }

export interface ProgramRow {
  surveyId: string;
  surveyTitle: string;
  tags: ProgramTag[];
  responses7d: number;
  lastNps: number | null;
  sentimentTrend: 'improving' | 'stable' | 'declining';
  velocityScore: number;
  healthStatus: 'healthy' | 'attention' | 'critical';
  lastActivityAt: string | null;
  sparkline: number[];
}

export interface ProgramsPage {
  programs: ProgramRow[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface ProgramsQueryOpts {
  page?: number;
  pageSize?: number;
  sort?: 'health' | 'nps' | 'responses' | 'lastActivity' | 'name';
  order?: 'asc' | 'desc';
  tagId?: string | null;
  status?: 'healthy' | 'attention' | 'critical' | null;
}

export interface HealthScoreResult {
  totalScore: number;
  status: 'healthy' | 'attention' | 'critical';
  components: {
    nps: { score: number; weight: number; contribution: number };
    sentiment: { score: number; weight: number; contribution: number };
    responseVelocity: { score: number; weight: number; contribution: number };
    anomalyFree: { score: number; weight: number; contribution: number };
  };
  /** Always [] today — org_health_score is UNIQUE(org_id), a single snapshot with no
   *  time series behind it. See file header "Documented gaps". */
  history: Array<{ date: string; totalScore: number }>;
  computedAt: string | null;
}

export interface TrendsResult {
  series: Array<{ date: string; avgNps: number; totalResponses: number; avgSentiment: number }>;
  benchmark: { nps: number | null; source: string | null };
}

export interface TopicRow {
  topicLabel: string;
  frequency: number;
  avgSentiment: number;
  isNewThisWeek: boolean;
  frequencyChangePct: number | null;
  rank: number;
  surveyIds: string[];
}

export interface TopicsResult {
  weekStart: string | null;
  topics: TopicRow[];
}

export interface TopicBreakdownResult {
  topicLabel: string;
  frequency: number;
  bySurvey: Array<{ surveyId: string; surveyTitle: string; count: number }>;
  /** Always [] — org-level topic breakdown has no wired verbatim-citation source yet
   *  (Decision 24: citation-bearing content stays gated behind
   *  ORG_BRIEF_ENABLE_INSIGHT_CITATIONS until Tag Report's redaction hook lands). Never
   *  reaches into response_embeddings for raw text as a substitute. */
  sampleQuotes: string[];
}

export interface AlertRow {
  id: string;
  surveyId: string | null;
  surveyTitle: string | null;
  description: string;
  severity: string;
  detectedAt: string;
  resolvedAt: string | null;
  isAcknowledged: boolean;
}

export interface AlertsResult {
  alerts: AlertRow[];
  totalUnresolved: number;
}

export interface BriefHistoryRow {
  id: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  briefText: string | null;
  recommendationCount: number;
  hasCriticalSignal: boolean;
  generatedAt: string | null;
  modelVersion: string | null;
  source: 'scheduled' | 'manual';
  parentCheckpointId: string | null;
}

export interface BriefHistoryResult {
  briefs: BriefHistoryRow[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface CheckpointCompareSide {
  id: string;
  dateRangeLabel: string;
  verdict: string;
  metrics: { nps: number | null; sentiment: number | null; responses: number | null };
}

export interface CheckpointComparisonDelta {
  key: 'nps' | 'sentiment' | 'responses';
  label: string;
  delta: number;
  positive: boolean;
}

export interface CheckpointComparisonResult {
  previous: CheckpointCompareSide;
  current: CheckpointCompareSide;
  deltas: CheckpointComparisonDelta[];
}

export interface TagMetricRow {
  tagId: string;
  tagName: string;
  color: string | null;
  surveyCount: number;
  aggregateNps: number | null;
  topTopic: string | null;
  healthStatus: 'healthy' | 'attention' | 'critical';
  sparkline14d: number[];
  responses: number;
}

export interface TagMetricsResult {
  tags: TagMetricRow[];
}

const DELTA_LABELS: Record<'nps' | 'sentiment' | 'responses', string> = {
  nps: 'NPS', sentiment: 'Sentiment', responses: 'Responses',
};

/** Dependency-free "start – end" label (no date-formatting library in the backend). */
function formatDateRangeLabel(start: string, end: string): string {
  return `${start} – ${end}`;
}

// ── Service ───────────────────────────────────────────────────────────────────────

export class OrgMetricsService {
  // ── Dashboard (GET /api/org/dashboard) ───────────────────────────────────────
  async getDashboardPayload(orgId: string): Promise<Cached<DashboardPayload | { error: 'NO_SURVEYS' }>> {
    return cachedFetch(`org:${orgId}:dashboard`, 120, () => this.fetchDashboardPayload(orgId));
  }

  private async fetchDashboardPayload(orgId: string): Promise<DashboardPayload | { error: 'NO_SURVEYS' }> {
    const { rows: surveyCountRows } = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM surveys WHERE org_id = $1 AND deleted_at IS NULL`,
      [orgId],
    );
    if (num(surveyCountRows[0]?.count) === 0) return { error: 'NO_SURVEYS' };

    const [
      { rows: profileRows },
      { rows: healthRows },
      { rows: dailyRows },
      { rows: weeklyRows },
      { rows: briefRows },
      { rows: todayRows },
      { rows: totalRows },
    ] = await Promise.all([
      query(`SELECT org_id, brand_name FROM org_profiles WHERE org_id = $1`, [orgId]).catch(() => ({ rows: [] })),
      query(`SELECT * FROM org_health_score WHERE org_id = $1`, [orgId]),
      query(`SELECT * FROM org_metrics_daily WHERE org_id = $1 ORDER BY date DESC LIMIT 1`, [orgId]),
      query(`SELECT * FROM org_metrics_weekly WHERE org_id = $1 ORDER BY week_start DESC LIMIT 1`, [orgId]),
      query(`SELECT * FROM org_crystal_briefs WHERE org_id = $1 ORDER BY date_range_start DESC LIMIT 1`, [orgId]),
      query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM responses WHERE org_id = $1 AND submitted_at >= CURRENT_DATE`, [orgId]),
      query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM responses WHERE org_id = $1`, [orgId]),
    ]);

    const profile = profileRows[0] as { org_id: string; brand_name?: string } | undefined;
    const health = healthRows[0] as Record<string, unknown> | undefined;
    const daily = dailyRows[0] as Record<string, unknown> | undefined;
    const weekly = weeklyRows[0] as Record<string, unknown> | undefined;
    const brief = briefRows[0] as Record<string, unknown> | undefined;

    let activeSurveys = daily ? num(daily.active_surveys) : null;
    if (activeSurveys == null) {
      const { rows } = await query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM surveys WHERE org_id = $1 AND status = 'active' AND deleted_at IS NULL`,
        [orgId],
      );
      activeSurveys = num(rows[0]?.count);
    }

    const avgNps = weekly ? num(weekly.avg_nps) : (daily ? num(daily.avg_nps) : 0);
    const avgSentiment = weekly ? num(weekly.avg_sentiment) : (daily ? num(daily.avg_sentiment) : 0);
    const npsWowDelta = weekly ? num(weekly.nps_wow_delta) : 0;
    const sentimentWowDelta = weekly ? numOrNull(weekly.sentiment_wow_delta) : null;

    return {
      org: { id: orgId, name: profile?.brand_name || orgId },
      healthScore: health ? {
        total: num(health.total_score),
        components: {
          nps: num(health.nps_score),
          sentiment: num(health.sentiment_score),
          velocity: num(health.response_velocity_score),
          anomalyFree: num(health.anomaly_free_score),
        },
        computedAt: (health.computed_at as string | undefined) ?? null,
      } : null,
      kpis: {
        activeSurveys,
        totalResponses: num(totalRows[0]?.count),
        responsesToday: num(todayRows[0]?.count),
        avgNps,
        npsWowDelta,
        avgSentiment,
        sentimentTrend: classifySentimentTrend(sentimentWowDelta),
      },
      crystalBrief: brief ? mapCrystalBriefRow(brief) : null,
    };
  }

  // ── Health score (GET /api/org/health-score) ─────────────────────────────────
  async getHealthScore(orgId: string): Promise<Cached<HealthScoreResult | null>> {
    return cachedFetch(`org:${orgId}:health-score`, 300, () => this.fetchHealthScore(orgId));
  }

  private async fetchHealthScore(orgId: string): Promise<HealthScoreResult | null> {
    const { rows } = await query(`SELECT * FROM org_health_score WHERE org_id = $1`, [orgId]);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;

    const total = num(row.total_score);
    const status: HealthScoreResult['status'] = total >= 70 ? 'healthy' : total >= 40 ? 'attention' : 'critical';

    // Weights per docs/org-dashboard/ARCHITECTURE.md's GET /api/org/health-score contract
    // (matches the real compute_all_org_health_scores() procedure's own weighting).
    const weights = { nps: 0.4, sentiment: 0.3, responseVelocity: 0.2, anomalyFree: 0.1 };
    const npsScore = num(row.nps_score);
    const sentimentScore = num(row.sentiment_score);
    const velocityScore = num(row.response_velocity_score);
    const anomalyFreeScore = num(row.anomaly_free_score);

    return {
      totalScore: total,
      status,
      components: {
        nps: { score: npsScore, weight: weights.nps, contribution: npsScore * weights.nps },
        sentiment: { score: sentimentScore, weight: weights.sentiment, contribution: sentimentScore * weights.sentiment },
        responseVelocity: { score: velocityScore, weight: weights.responseVelocity, contribution: velocityScore * weights.responseVelocity },
        anomalyFree: { score: anomalyFreeScore, weight: weights.anomalyFree, contribution: anomalyFreeScore * weights.anomalyFree },
      },
      // Documented gap — see file header: org_health_score is UNIQUE(org_id), no time series.
      history: [],
      computedAt: (row.computed_at as string | undefined) ?? null,
    };
  }

  // ── Trends (GET /api/org/dashboard/trends) ───────────────────────────────────
  async getTrends(orgId: string, opts: { range?: string; granularity?: string } = {}): Promise<Cached<TrendsResult>> {
    const range = (['7d', '30d', '90d', '1y'] as const).includes(opts.range as '7d' | '30d' | '90d' | '1y')
      ? (opts.range as '7d' | '30d' | '90d' | '1y')
      : '30d';
    const granularity = opts.granularity === 'daily' || opts.granularity === 'weekly'
      ? opts.granularity
      : (range === '1y' ? 'weekly' : 'daily');

    return cachedFetch(`org:${orgId}:trends:${range}:${granularity}`, 900, () => this.fetchTrends(orgId, range, granularity));
  }

  private async fetchTrends(orgId: string, range: '7d' | '30d' | '90d' | '1y', granularity: 'daily' | 'weekly'): Promise<TrendsResult> {
    const days = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[range];

    const seriesPromise = granularity === 'weekly'
      ? query(
          `SELECT week_start AS date, avg_nps, total_responses, avg_sentiment
             FROM org_metrics_weekly
            WHERE org_id = $1 AND week_start >= CURRENT_DATE - $2::int
            ORDER BY week_start ASC`,
          [orgId, days],
        )
      : query(
          `SELECT date, avg_nps, total_responses, avg_sentiment
             FROM org_metrics_daily
            WHERE org_id = $1 AND date >= CURRENT_DATE - $2::int
            ORDER BY date ASC`,
          [orgId, days],
        );

    const [{ rows: seriesRows }, { rows: profileRows }] = await Promise.all([
      seriesPromise,
      query<{ benchmark_nps: number | null }>(`SELECT benchmark_nps FROM org_profiles WHERE org_id = $1`, [orgId]).catch(() => ({ rows: [] })),
    ]);

    const benchmarkNps = numOrNull(profileRows[0]?.benchmark_nps);

    return {
      series: (seriesRows as Record<string, unknown>[]).map((r) => ({
        date: typeof r.date === 'string' ? r.date : new Date(r.date as string).toISOString().slice(0, 10),
        avgNps: num(r.avg_nps),
        totalResponses: num(r.total_responses),
        avgSentiment: num(r.avg_sentiment),
      })),
      benchmark: { nps: benchmarkNps, source: benchmarkNps != null ? 'org_profiles' : null },
    };
  }

  // ── Programs (GET /api/org/dashboard/programs) ───────────────────────────────
  async getPrograms(orgId: string, opts: ProgramsQueryOpts = {}): Promise<Cached<ProgramsPage>> {
    const page = Math.max(1, Math.trunc(opts.page ?? 1));
    const pageSize = ([10, 25, 50] as const).includes(opts.pageSize as 10 | 25 | 50) ? (opts.pageSize as number) : 25;
    const sort = (['health', 'nps', 'responses', 'lastActivity', 'name'] as const).includes(opts.sort as 'health')
      ? (opts.sort as ProgramsQueryOpts['sort'])
      : 'health';
    const order = opts.order === 'desc' ? 'desc' : 'asc';
    const tagId = opts.tagId ?? null;
    const status = (['healthy', 'attention', 'critical'] as const).includes(opts.status as 'healthy') ? opts.status! : null;

    const key = `org:${orgId}:programs:p${page}:${pageSize}:${sort}:${order}:${tagId ?? '-'}:${status ?? '-'}`;
    return cachedFetch(key, 300, () => this.fetchProgramsPage(orgId, { page, pageSize, sort: sort!, order, tagId, status }));
  }

  private async fetchProgramsPage(orgId: string, opts: Required<Pick<ProgramsQueryOpts, 'page' | 'pageSize' | 'sort' | 'order'>> & { tagId: string | null; status: string | null }): Promise<ProgramsPage> {
    const { page, pageSize, sort, order, tagId, status } = opts;
    const params: unknown[] = [orgId];
    const clauses: string[] = ['shs.org_id = $1', 's.deleted_at IS NULL'];

    if (tagId) { params.push(tagId); clauses.push(`$${params.length} = ANY(shs.tag_ids)`); }
    if (status) { params.push(status); clauses.push(`shs.health_status = $${params.length}`); }
    const where = clauses.join(' AND ');

    const ORDER_COLUMN: Record<string, string> = {
      health: `CASE shs.health_status WHEN 'critical' THEN 0 WHEN 'attention' THEN 1 WHEN 'healthy' THEN 2 ELSE 3 END`,
      nps: 'shs.last_nps',
      // response_velocity_7d IS the raw 7-day response count on this materialized view
      // (confirmed against the real migration) — the exact same number surfaced as
      // `responses7d` below, so this sort key and that field are consistent by construction.
      responses: 'shs.response_velocity_7d',
      lastActivity: 'shs.last_activity_at',
      name: 's.title',
    };
    const orderCol = ORDER_COLUMN[sort] ?? ORDER_COLUMN.health;
    const orderDir = order === 'desc' ? 'DESC' : 'ASC';

    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT shs.survey_id, s.title AS survey_title, shs.tag_ids, shs.tag_names,
                shs.last_nps, shs.sentiment_trend, shs.response_velocity_7d,
                shs.health_status, shs.last_activity_at
           FROM survey_health_summary shs
           JOIN surveys s ON s.id = shs.survey_id
          WHERE ${where}
          ORDER BY ${orderCol} ${orderDir}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      ),
      query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM survey_health_summary shs
           JOIN surveys s ON s.id = shs.survey_id
          WHERE ${where}`,
        params.slice(0, -2),
      ),
    ]);

    const pageRows = rows as Array<Record<string, unknown>>;
    const surveyIds = pageRows.map((r) => r.survey_id as string);

    // Batched, page-scoped lookups — never N+1 per survey.
    const [tagColorMap, velocityMap, sparklineMap] = await Promise.all([
      this.fetchTagColors(pageRows),
      this.fetchVelocityScores(surveyIds),
      this.fetchSparklines(surveyIds),
    ]);

    const programs: ProgramRow[] = pageRows.map((r) => {
      const surveyId = r.survey_id as string;
      const tagIds = (r.tag_ids as string[] | null) ?? [];
      const tagNames = (r.tag_names as string[] | null) ?? [];
      const tags: ProgramTag[] = tagIds.map((id, i) => {
        const fromMap = tagColorMap.get(id);
        return { id, name: fromMap?.name ?? tagNames[i] ?? '', color: fromMap?.color ?? null };
      });
      const lastNps = numOrNull(r.last_nps);
      return {
        surveyId,
        surveyTitle: (r.survey_title as string) ?? '',
        tags,
        responses7d: num(r.response_velocity_7d),
        lastNps,
        sentimentTrend: (r.sentiment_trend as ProgramRow['sentimentTrend']) ?? 'stable',
        velocityScore: velocityMap.get(surveyId) ?? 1,
        healthStatus: (r.health_status as ProgramRow['healthStatus']) ?? 'healthy',
        lastActivityAt: (r.last_activity_at as string | undefined) ?? null,
        sparkline: sparklineMap.get(surveyId) ?? (lastNps != null ? [lastNps] : []),
      };
    });

    const total = num(countRows[0]?.count);
    return {
      programs,
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  /** One batched lookup for tag color/name across every distinct tag_id on the current page. */
  private async fetchTagColors(pageRows: Array<Record<string, unknown>>): Promise<Map<string, { name: string; color: string | null }>> {
    const allIds = new Set<string>();
    for (const r of pageRows) {
      for (const id of (r.tag_ids as string[] | null) ?? []) allIds.add(id);
    }
    const map = new Map<string, { name: string; color: string | null }>();
    if (allIds.size === 0) return map;
    const { rows } = await query<{ id: string; name: string; color: string | null }>(
      `SELECT id, name, color FROM survey_tags WHERE id = ANY($1::uuid[])`,
      [Array.from(allIds)],
    ).catch(() => ({ rows: [] }));
    for (const r of rows) map.set(r.id, { name: r.name, color: r.color });
    return map;
  }

  /**
   * One batched query computing a current-vs-prior-7-day response-count ratio per survey
   * (frontend's `velocityScore // 0-3x` field) — scoped to this page's survey_ids only.
   * Judgment call: no per-survey velocity RATIO is pre-aggregated anywhere (unlike
   * `response_velocity_7d`, which is a raw count) — this mirrors org_metrics_daily's own
   * "current pulse vs trailing baseline" shape at survey grain, capped at 3x. No prior-
   * period data (brand-new survey) -> neutral 1.0 rather than a fabricated extreme; some
   * current activity with zero prior -> capped high (3.0), a real "just started" signal.
   */
  private async fetchVelocityScores(surveyIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (surveyIds.length === 0) return map;
    const { rows } = await query<{ survey_id: string; current_count: number; prior_count: number }>(
      `SELECT survey_id,
              COUNT(*) FILTER (WHERE submitted_at >= NOW() - INTERVAL '7 days')::int AS current_count,
              COUNT(*) FILTER (
                WHERE submitted_at >= NOW() - INTERVAL '14 days' AND submitted_at < NOW() - INTERVAL '7 days'
              )::int AS prior_count
         FROM responses
        WHERE survey_id = ANY($1::uuid[]) AND submitted_at >= NOW() - INTERVAL '14 days'
        GROUP BY survey_id`,
      [surveyIds],
    ).catch(() => ({ rows: [] }));
    for (const r of rows) {
      const current = num(r.current_count);
      const prior = num(r.prior_count);
      let score: number;
      if (prior > 0) score = Math.min(current / prior, 3);
      else if (current > 0) score = 3;
      else score = 1;
      map.set(r.survey_id, Math.round(score * 100) / 100);
    }
    return map;
  }

  /**
   * One batched query for the last-7-day daily NPS sparkline, scoped to this page's
   * survey_ids only (per IMPLEMENTATION_SPEC.md: org_metrics_daily is org-grain, so
   * per-survey sparklines read `responses` directly, GROUP BY survey_id, date).
   */
  private async fetchSparklines(surveyIds: string[]): Promise<Map<string, number[]>> {
    const map = new Map<string, number[]>();
    if (surveyIds.length === 0) return map;
    const { rows } = await query<{ survey_id: string; day: string; avg_nps: number }>(
      `SELECT survey_id, date_trunc('day', submitted_at)::date::text AS day, AVG(nps_score)::numeric AS avg_nps
         FROM responses
        WHERE survey_id = ANY($1::uuid[]) AND submitted_at >= NOW() - INTERVAL '7 days' AND nps_score IS NOT NULL
        GROUP BY survey_id, day
        ORDER BY survey_id, day ASC`,
      [surveyIds],
    ).catch(() => ({ rows: [] }));
    for (const r of rows) {
      const arr = map.get(r.survey_id) ?? [];
      arr.push(num(r.avg_nps));
      map.set(r.survey_id, arr);
    }
    return map;
  }

  // ── Topics (GET /api/org/dashboard/topics) ───────────────────────────────────
  async getTopics(orgId: string): Promise<Cached<TopicsResult>> {
    return cachedFetch(`org:${orgId}:topics`, 3_600, () => this.fetchTopics(orgId));
  }

  private async fetchTopics(orgId: string): Promise<TopicsResult> {
    const { rows: weekRows } = await query<{ week_start: string }>(
      `SELECT MAX(week_start)::text AS week_start FROM org_topic_trends WHERE org_id = $1`,
      [orgId],
    );
    const weekStart = weekRows[0]?.week_start ?? null;
    if (!weekStart) return { weekStart: null, topics: [] };

    const { rows } = await query(
      `SELECT topic_label, frequency, avg_sentiment, is_new_this_week, frequency_change_pct, rank
         FROM org_topic_trends
        WHERE org_id = $1 AND week_start = $2
        ORDER BY rank ASC
        LIMIT 20`,
      [orgId, weekStart],
    );

    const topicLabels = (rows as Record<string, unknown>[]).map((r) => r.topic_label as string);
    const surveyIdsByTopic = await this.fetchTopicSurveyIds(orgId, topicLabels);

    return {
      weekStart,
      topics: (rows as Record<string, unknown>[]).map((r) => ({
        topicLabel: r.topic_label as string,
        frequency: num(r.frequency),
        avgSentiment: num(r.avg_sentiment),
        isNewThisWeek: Boolean(r.is_new_this_week),
        frequencyChangePct: numOrNull(r.frequency_change_pct),
        rank: num(r.rank),
        surveyIds: surveyIdsByTopic.get(r.topic_label as string) ?? [],
      })),
    };
  }

  /**
   * Batched lookup of which surveys contribute to each of the current top-20 topic
   * labels. `survey_topics` DOES carry `survey_id` (unlike `org_topic_trends`) — this
   * joins on the exact same (org_id, name, time_window='all_time') predicate
   * `compute_org_topic_trends()` itself uses to roll `topic_label` up from
   * `survey_topics.name`, so this is a precise join, not a fuzzy/guessed match.
   */
  private async fetchTopicSurveyIds(orgId: string, topicLabels: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (topicLabels.length === 0) return map;
    const { rows } = await query<{ topic_label: string; survey_ids: string[] }>(
      `SELECT st.name AS topic_label, array_agg(DISTINCT st.survey_id) AS survey_ids
         FROM survey_topics st
         JOIN surveys s ON s.id = st.survey_id AND s.deleted_at IS NULL
        WHERE st.org_id = $1 AND st.time_window = 'all_time' AND st.name = ANY($2::text[])
        GROUP BY st.name`,
      [orgId, topicLabels],
    ).catch(() => ({ rows: [] }));
    for (const r of rows) map.set(r.topic_label, r.survey_ids ?? []);
    return map;
  }

  // ── Topic breakdown (GET /api/org/dashboard/topics/:topicLabel) ──────────────
  async getTopicBreakdown(orgId: string, topicLabel: string): Promise<TopicBreakdownResult> {
    const { rows } = await query<{ survey_id: string; survey_title: string; count: number }>(
      `SELECT st.survey_id, s.title AS survey_title, st.volume::int AS count
         FROM survey_topics st
         JOIN surveys s ON s.id = st.survey_id AND s.deleted_at IS NULL
        WHERE st.org_id = $1 AND st.name = $2 AND st.time_window = 'all_time'
        ORDER BY st.volume DESC`,
      [orgId, topicLabel],
    );
    const bySurvey = (rows as Array<{ survey_id: string; survey_title: string; count: number }>)
      .map((r) => ({ surveyId: r.survey_id, surveyTitle: r.survey_title, count: num(r.count) }));
    const frequency = bySurvey.reduce((sum, r) => sum + r.count, 0);
    return { topicLabel, frequency, bySurvey, sampleQuotes: [] };
  }

  // ── Tag metrics (GET /api/org/dashboard/tags) ─────────────────────────────────
  async getTagMetrics(orgId: string): Promise<Cached<TagMetricsResult>> {
    return cachedFetch(`org:${orgId}:tags`, 300, () => this.fetchTagMetrics(orgId));
  }

  private async fetchTagMetrics(orgId: string): Promise<TagMetricsResult> {
    const { rows: tagRows } = await query<{ id: string; name: string; color: string | null; survey_count: number }>(
      `SELECT t.id, t.name, t.color, COUNT(DISTINCT m.survey_id)::int AS survey_count
         FROM survey_tags t
         LEFT JOIN survey_tag_mappings m ON m.tag_id = t.id
        WHERE t.org_id = $1
        GROUP BY t.id, t.name, t.color
        ORDER BY t.name ASC`,
      [orgId],
    );
    if (tagRows.length === 0) return { tags: [] };
    const tagIds = tagRows.map((t) => t.id);

    const [metricsMap, sparklineMap, healthMap, topTopicMap] = await Promise.all([
      this.fetchTagLatestMetrics(orgId),
      this.fetchTagSparklines(orgId),
      this.fetchTagHealth(tagIds),
      this.fetchTagTopTopic(tagIds),
    ]);

    return {
      tags: tagRows.map((t) => ({
        tagId: t.id,
        tagName: t.name,
        color: t.color,
        surveyCount: num(t.survey_count),
        aggregateNps: metricsMap.get(t.id)?.avgNps ?? null,
        topTopic: topTopicMap.get(t.id) ?? null,
        healthStatus: healthMap.get(t.id) ?? 'healthy',
        sparkline14d: sparklineMap.get(t.id) ?? [],
        responses: metricsMap.get(t.id)?.responses7d ?? 0,
      })),
    };
  }

  private async fetchTagLatestMetrics(orgId: string): Promise<Map<string, { avgNps: number | null; responses7d: number }>> {
    const map = new Map<string, { avgNps: number | null; responses7d: number }>();
    const { rows } = await query<{ tag_id: string; latest_avg_nps: number | null; responses_7d: number }>(
      `SELECT tag_id,
              (ARRAY_AGG(avg_nps ORDER BY date DESC))[1] AS latest_avg_nps,
              COALESCE(SUM(total_responses) FILTER (WHERE date >= CURRENT_DATE - 7), 0)::int AS responses_7d
         FROM tag_metrics
        WHERE org_id = $1
        GROUP BY tag_id`,
      [orgId],
    ).catch(() => ({ rows: [] }));
    for (const r of rows) map.set(r.tag_id, { avgNps: numOrNull(r.latest_avg_nps), responses7d: num(r.responses_7d) });
    return map;
  }

  private async fetchTagSparklines(orgId: string): Promise<Map<string, number[]>> {
    const map = new Map<string, number[]>();
    const { rows } = await query<{ tag_id: string; avg_nps: number }>(
      `SELECT tag_id, date, avg_nps
         FROM tag_metrics
        WHERE org_id = $1 AND date >= CURRENT_DATE - 14
        ORDER BY tag_id, date ASC`,
      [orgId],
    ).catch(() => ({ rows: [] }));
    for (const r of rows) {
      const arr = map.get(r.tag_id) ?? [];
      arr.push(num(r.avg_nps));
      map.set(r.tag_id, arr);
    }
    return map;
  }

  private async fetchTagHealth(tagIds: string[]): Promise<Map<string, 'healthy' | 'attention' | 'critical'>> {
    const map = new Map<string, 'healthy' | 'attention' | 'critical'>();
    if (tagIds.length === 0) return map;
    const { rows } = await query<{ tag_id: string; health_status: string }>(
      `SELECT m.tag_id,
              CASE
                WHEN bool_or(shs.health_status = 'critical')  THEN 'critical'
                WHEN bool_or(shs.health_status = 'attention') THEN 'attention'
                ELSE 'healthy'
              END AS health_status
         FROM survey_tag_mappings m
         JOIN survey_health_summary shs ON shs.survey_id = m.survey_id
        WHERE m.tag_id = ANY($1::uuid[])
        GROUP BY m.tag_id`,
      [tagIds],
    ).catch(() => ({ rows: [] }));
    for (const r of rows) map.set(r.tag_id, r.health_status as 'healthy' | 'attention' | 'critical');
    return map;
  }

  private async fetchTagTopTopic(tagIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (tagIds.length === 0) return map;
    const { rows } = await query<{ tag_id: string; topic_label: string }>(
      `SELECT sub.tag_id, sub.topic_label FROM (
         SELECT m.tag_id, st.name AS topic_label,
                ROW_NUMBER() OVER (PARTITION BY m.tag_id ORDER BY SUM(st.volume) DESC) AS rn
           FROM survey_tag_mappings m
           JOIN survey_topics st ON st.survey_id = m.survey_id AND st.time_window = 'all_time'
          WHERE m.tag_id = ANY($1::uuid[])
          GROUP BY m.tag_id, st.name
       ) sub WHERE sub.rn = 1`,
      [tagIds],
    ).catch(() => ({ rows: [] }));
    for (const r of rows) map.set(r.tag_id, r.topic_label);
    return map;
  }

  // ── Alerts (GET /api/org/dashboard/alerts) ───────────────────────────────────
  async getAlerts(orgId: string, opts: { limit?: number } = {}): Promise<Cached<AlertsResult>> {
    const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 20)), 100);
    return cachedFetch(`org:${orgId}:alerts:${limit}`, 30, () => this.fetchAlerts(orgId, limit));
  }

  private async fetchAlerts(orgId: string, limit: number): Promise<AlertsResult> {
    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT ae.id, ae.survey_id, s.title AS survey_title, ae.description, ae.severity,
                ae.triggered_at, ae.resolved_at, ae.status
           FROM alert_events ae
      LEFT JOIN surveys s ON s.id = ae.survey_id
          WHERE ae.org_id = $1 AND ae.status <> 'resolved'
          ORDER BY ae.triggered_at DESC
          LIMIT $2`,
        [orgId, limit],
      ),
      query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM alert_events WHERE org_id = $1 AND status <> 'resolved'`,
        [orgId],
      ),
    ]);

    return {
      alerts: (rows as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        surveyId: (r.survey_id as string | undefined) ?? null,
        surveyTitle: (r.survey_title as string | undefined) ?? null,
        description: r.description as string,
        severity: r.severity as string,
        detectedAt: r.triggered_at as string,
        resolvedAt: (r.resolved_at as string | undefined) ?? null,
        isAcknowledged: r.status === 'acknowledged',
      })),
      totalUnresolved: num(countRows[0]?.count),
    };
  }

  async invalidateAlerts(orgId: string): Promise<void> {
    // Alerts cache is keyed per-limit; the common default (20) is the one worth
    // eagerly invalidating on a new alert firing (Decision-driven <30s TTL already
    // bounds staleness for any other limit value).
    await invalidate(`org:${orgId}:alerts:20`);
  }

  // ── Crystal brief (GET /api/org/dashboard/crystal-brief) ─────────────────────
  async getLatestCrystalBrief(orgId: string): Promise<Cached<(CrystalBriefSummary & { inputSnapshot: unknown }) | null>> {
    return cachedFetch(`org:${orgId}:crystal-brief`, 3_600, () => this.fetchLatestCrystalBrief(orgId));
  }

  private async fetchLatestCrystalBrief(orgId: string): Promise<(CrystalBriefSummary & { inputSnapshot: unknown }) | null> {
    const { rows } = await query(
      `SELECT * FROM org_crystal_briefs WHERE org_id = $1 ORDER BY date_range_start DESC LIMIT 1`,
      [orgId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ...mapCrystalBriefRow(row),
      // Decision 26 precedent (no new role-gating system exists anywhere in this
      // feature's reconciliation) applied here too — always included rather than
      // building a one-off "org admin" check nothing else in this feature has.
      inputSnapshot: row.input_snapshot ?? null,
    };
  }

  async invalidateCrystalBrief(orgId: string): Promise<void> {
    await invalidate(`org:${orgId}:crystal-brief`);
  }

  // ── Brief history (GET /api/org/dashboard/briefs) ────────────────────────────
  async getBriefHistory(orgId: string, opts: { page?: number; pageSize?: number } = {}): Promise<Cached<BriefHistoryResult>> {
    const page = Math.max(1, Math.trunc(opts.page ?? 1));
    const pageSize = Math.min(Math.max(1, Math.trunc(opts.pageSize ?? 25)), 100);
    return cachedFetch(`org:${orgId}:briefs:p${page}:${pageSize}`, 300, () => this.fetchBriefHistory(orgId, page, pageSize));
  }

  private async fetchBriefHistory(orgId: string, page: number, pageSize: number): Promise<BriefHistoryResult> {
    // Queries the two source tables directly (not the org_report_history view) since the
    // view's real column set (supabase/migrations/20260705000009_org_report_history.sql)
    // doesn't carry brief_text/recommendations/model_version — this needs those for the
    // list UI. `parent_checkpoint_id` is aliased from each side the same way the view does.
    const offset = (page - 1) * pageSize;
    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT id, date_range_start, date_range_end, brief_text, recommendations, generated_at,
                model_version, 'scheduled' AS source, parent_checkpoint_id
           FROM org_crystal_briefs WHERE org_id = $1
          UNION ALL
         SELECT id, date_range_start, date_range_end, brief_text, recommendations, generated_at,
                model_version, 'manual' AS source, compared_against_brief_id AS parent_checkpoint_id
           FROM org_custom_summaries WHERE org_id = $1 AND status = 'completed'
          ORDER BY date_range_start DESC
          LIMIT $2 OFFSET $3`,
        [orgId, pageSize, offset],
      ),
      query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM (
           SELECT id FROM org_crystal_briefs WHERE org_id = $1
           UNION ALL
           SELECT id FROM org_custom_summaries WHERE org_id = $1 AND status = 'completed'
         ) t`,
        [orgId],
      ),
    ]);

    const briefs: BriefHistoryRow[] = (rows as Record<string, unknown>[]).map((r) => {
      const recs = Array.isArray(r.recommendations) ? r.recommendations as Array<Record<string, unknown>> : [];
      return {
        id: r.id as string,
        dateRangeStart: r.date_range_start as string,
        dateRangeEnd: r.date_range_end as string,
        briefText: (r.brief_text as string | undefined) ?? null,
        recommendationCount: recs.length,
        // "Critical signal" isn't defined precisely anywhere in the design docs for this
        // list badge — judgment call: a recommendation whose action_type is 'investigate'
        // (the only action type that maps to "something needs attention now").
        hasCriticalSignal: recs.some((rec) => rec.action_type === 'investigate' || rec.actionType === 'investigate'),
        generatedAt: (r.generated_at as string | undefined) ?? null,
        modelVersion: (r.model_version as string | undefined) ?? null,
        source: r.source as 'scheduled' | 'manual',
        parentCheckpointId: (r.parent_checkpoint_id as string | undefined) ?? null,
      };
    });

    const total = num(countRows[0]?.count);
    return { briefs, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
  }

  // ── Compare briefs (GET /api/org/dashboard/briefs/:briefId/compare/:otherId) ─
  // Matches app/src/types/orgDashboard.ts's `CheckpointComparisonResult` exactly (the
  // frontend hook/route are already built against this shape). No frontend UX spec exists
  // yet for this endpoint (DECISIONS.md Decision 16 item 10) — this is a minimal, honestly-
  // scoped implementation, not a finished design.
  async compareBriefs(orgId: string, briefId: string, otherId: string): Promise<CheckpointComparisonResult | null> {
    const [rowA, rowB] = await Promise.all([
      this.fetchBriefById(orgId, briefId),
      this.fetchBriefById(orgId, otherId),
    ]);
    if (!rowA || !rowB) return null;

    // Order chronologically — earlier range is "previous", later is "current" —
    // regardless of which id the caller passed as :briefId vs :otherId.
    const [prevRow, curRow] = String(rowA.date_range_start) <= String(rowB.date_range_start)
      ? [rowA, rowB] : [rowB, rowA];

    const toMetrics = (row: Record<string, unknown>): CheckpointCompareSide['metrics'] => {
      const snapshot = (row.input_snapshot as Record<string, unknown> | null) ?? null;
      // org_brief_graph.py's _build_input_snapshot() persists both the org-shaped keys
      // (avg_nps/avg_sentiment/total_responses) AND survey-checkpoint-shaped aliases
      // (nps/response_count) for compute_delta() — accept either.
      return {
        nps: numOrNull(snapshot?.avg_nps ?? snapshot?.nps),
        sentiment: numOrNull(snapshot?.avg_sentiment),
        responses: numOrNull(snapshot?.total_responses ?? snapshot?.response_count),
      };
    };

    const prevMetrics = toMetrics(prevRow);
    const curMetrics = toMetrics(curRow);
    const npsDelta = prevMetrics.nps != null && curMetrics.nps != null ? curMetrics.nps - prevMetrics.nps : null;
    // "previous" is the fixed reference point; "current"'s verdict reflects the NPS
    // delta direction relative to it (±0.5 dead zone to avoid noise on rounding dust).
    const curVerdict = npsDelta == null ? 'Stable' : npsDelta > 0.5 ? 'Improving' : npsDelta < -0.5 ? 'Declining' : 'Stable';

    const previous: CheckpointCompareSide = {
      id: prevRow.id as string,
      dateRangeLabel: formatDateRangeLabel(prevRow.date_range_start as string, prevRow.date_range_end as string),
      verdict: 'Baseline',
      metrics: prevMetrics,
    };
    const current: CheckpointCompareSide = {
      id: curRow.id as string,
      dateRangeLabel: formatDateRangeLabel(curRow.date_range_start as string, curRow.date_range_end as string),
      verdict: curVerdict,
      metrics: curMetrics,
    };

    const deltas: CheckpointComparisonDelta[] = (['nps', 'sentiment', 'responses'] as const)
      .map((key): CheckpointComparisonDelta | null => {
        const a = previous.metrics[key];
        const b = current.metrics[key];
        if (a == null || b == null) return null;
        const delta = b - a;
        return { key, label: DELTA_LABELS[key], delta, positive: delta >= 0 };
      })
      .filter((d): d is CheckpointComparisonDelta => d !== null);

    return { previous, current, deltas };
  }

  private async fetchBriefById(orgId: string, id: string): Promise<Record<string, unknown> | null> {
    const { rows } = await query(`SELECT * FROM org_crystal_briefs WHERE id = $1 AND org_id = $2`, [id, orgId]);
    if (rows[0]) return rows[0] as Record<string, unknown>;
    const { rows: customRows } = await query(`SELECT * FROM org_custom_summaries WHERE id = $1 AND org_id = $2`, [id, orgId]);
    return (customRows[0] as Record<string, unknown> | undefined) ?? null;
  }
}

export const orgMetricsService = new OrgMetricsService();
