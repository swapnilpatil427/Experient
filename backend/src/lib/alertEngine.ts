// Alert evaluation engine.
//
// Increment 1 covers deterministic evaluators (threshold + Z-score anomaly) for
// score/volume alerts, plus firing (Redis dedup → persist alert_event + history →
// publish an `alert.fired` notification event through the Event Engine) and the
// state machine (acknowledge / snooze / resolve). PELT changepoint + LLM narration
// (Crystal) land in a later increment.
import { query } from './db';
import { getRedisClient } from './redis';
import { publishNotificationEvent } from './notificationEvents';
import { linearForecast } from './forecast';
import { publishOrgEvent } from '../services/org-realtime.service';

// Dedup window per severity (ms) — prevents the same condition re-firing.
export const DEDUP_TTL_MS: Record<string, number> = { critical: 24 * 3600e3, warning: 6 * 3600e3, info: 1 * 3600e3, success: 1 * 3600e3 };

interface StatsResult {
  n: number;
  mean: number;
  std: number;
}

interface AnomalyResult extends StatsResult {
  isAnomaly: boolean;
  z: number;
}

// ── Statistics ──────────────────────────────────────────────────────────────

/** Mean + sample standard deviation of a numeric series. */
export function stats(series: number[]): StatsResult {
  const xs = series.filter((v) => typeof v === 'number' && Number.isFinite(v));
  const n = xs.length;
  if (n === 0) return { n: 0, mean: 0, std: 0 };
  const mean = xs.reduce((s, v) => s + v, 0) / n;
  const variance = n > 1 ? xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, std: Math.sqrt(variance) };
}

/** Z-score of `value` against a baseline `series`. */
export function zScore(series: number[], value: number): number {
  const { mean, std } = stats(series);
  if (std === 0) return 0;
  return (value - mean) / std;
}

/** Anomaly when |z| >= threshold (default 3) and there is enough baseline. */
export function detectAnomaly(series: number[], value: number, { z = 3, minPoints = 5 } = {}): AnomalyResult {
  const s = stats(series);
  if (s.n < minPoints) return { isAnomaly: false, z: 0, ...s };
  const score = zScore(series, value);
  return { isAnomaly: Math.abs(score) >= z, z: score, ...s };
}

/** NPS from an array of {nps_score} rows: %promoters − %detractors. */
export function computeNps(rows: Array<{ nps_score?: number | null }>): number | null {
  const scored = rows.filter((r) => r.nps_score != null);
  if (scored.length === 0) return null;
  const promoters = scored.filter((r) => (r.nps_score as number) >= 9).length;
  const detractors = scored.filter((r) => (r.nps_score as number) <= 6).length;
  return Math.round(((promoters - detractors) / scored.length) * 100);
}

// ── Firing ────────────────────────────────────────────────────────────────--

async function isDuplicate(orgId: string, ruleId: string, entityId: string | null, severity: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis || redis.status !== 'ready') return false;
  const ttl = DEDUP_TTL_MS[severity] || DEDUP_TTL_MS.info;
  const windowKey = Math.floor(Date.now() / ttl);
  const key = `alert:dedup:${orgId}:${ruleId}:${entityId || 'org'}:${windowKey}`;
  // SET NX: returns 'OK' if newly set, null if already present.
  const set = await redis.set(key, '1', 'PX', ttl, 'NX');
  return set === null;
}

async function resolveSubscribers(orgId: string, rule: AlertRule): Promise<string[]> {
  const { rows } = await query(
    `SELECT DISTINCT user_id FROM alert_subscriptions
      WHERE org_id = $1 AND user_id IS NOT NULL AND in_app_enabled = TRUE
        AND (rule_id = $2 OR (rule_id IS NULL AND (alert_type = $3 OR alert_type IS NULL)))`,
    [orgId, rule.id, rule.alert_type]
  );
  return (rows as Array<{ user_id: string }>).map((r) => r.user_id);
}

export { resolveSubscribers };

interface AlertRule {
  id: string;
  alert_type: string;
  severity?: string;
  threshold_config?: Record<string, unknown>;
  [key: string]: unknown;
}

interface FireAlertParams {
  orgId: string;
  surveyId?: string | null;
  severity: string;
  title: string;
  description: string;
  metricValue?: number | null;
  metricBaseline?: number | null;
  metricChange?: number | null;
  evidence?: Record<string, unknown>;
  crystalNarration?: string | null;
  crystalAction?: string | null;
}

/**
 * Fire an alert: dedup, persist alert_event + history, publish notification.
 * @returns the alert_event row, or null if deduped.
 */
export async function fireAlert(rule: AlertRule, {
  orgId, surveyId = null, severity, title, description,
  metricValue = null, metricBaseline = null, metricChange = null, evidence = {},
  crystalNarration = null, crystalAction = null,
}: FireAlertParams): Promise<Record<string, unknown> | null> {
  if (await isDuplicate(orgId, rule.id, surveyId, severity)) return null;

  const { rows: [event] } = await query(
    `INSERT INTO alert_events
       (org_id, rule_id, survey_id, alert_type, severity, title, description,
        crystal_narration, crystal_action, metric_value, metric_baseline, metric_change, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     RETURNING *`,
    [orgId, rule.id, surveyId, rule.alert_type, severity, title, description,
     crystalNarration, crystalAction, metricValue, metricBaseline, metricChange, JSON.stringify(evidence)]
  );

  await query(
    `INSERT INTO alert_history (alert_event_id, user_id, action, from_status, to_status)
     VALUES ($1, NULL, 'triggered', NULL, 'active')`,
    [(event as Record<string, unknown>).id]
  );

  // Deliver via the Notification Service (Event Engine). Empty recipients → org admins.
  const targetUserIds = await resolveSubscribers(orgId, rule);
  await publishNotificationEvent({
    type: 'alert.fired', orgId, priority: severity,
    targetUserIds, entityType: 'alert', entityId: String((event as Record<string, unknown>).id),
    title, body: crystalNarration || description,
    actionUrl: '/app/alerts',
    payload: { alertType: rule.alert_type, ruleId: rule.id, surveyId, metricValue, metricChange },
  }).catch(() => {});

  // Org Intelligence Dashboard live anomaly feed (docs/org-dashboard/DECISIONS.md
  // Decision 22/23 — SSE + Redis pub/sub over the existing alert_events table; no new
  // anomaly-storage infra). Additive only — never affects fireAlert's own return value
  // or the notification delivery above.
  const eventRow = event as Record<string, unknown>;
  publishOrgEvent(orgId, {
    type: 'anomaly_detected',
    payload: {
      alertId: eventRow.id, surveyId, severity, title, description,
      detectedAt: eventRow.triggered_at,
    },
  }).catch(() => {});

  return event as Record<string, unknown>;
}

// ── State machine ─────────────────────────────────────────────────────────--

const TRANSITIONS: Record<string, { to: string; stamp: string | null }> = {
  acknowledge: { to: 'acknowledged', stamp: 'acknowledged' },
  resolve:     { to: 'resolved',     stamp: 'resolved' },
  snooze:      { to: 'snoozed',      stamp: null },
};

export async function transitionAlert(
  eventId: string,
  orgId: string,
  action: string,
  userId: string,
  { snoozeUntil = null }: { snoozeUntil?: string | null } = {}
): Promise<Record<string, unknown> | null> {
  const t = TRANSITIONS[action];
  if (!t) throw new Error(`Unknown alert action: ${action}`);

  const { rows: [current] } = await query(
    'SELECT status FROM alert_events WHERE id = $1 AND org_id = $2', [eventId, orgId]
  );
  if (!current) return null;

  const sets = ['status = $3'];
  const params: unknown[] = [eventId, orgId, t.to];
  let p = 4;
  if (t.stamp) {
    sets.push(`${t.stamp}_at = NOW()`, `${t.stamp}_by = $${p++}`);
    params.push(userId);
  }
  if (action === 'snooze') {
    sets.push(`snoozed_until = $${p++}`, `snoozed_by = $${p++}`);
    params.push(snoozeUntil, userId);
  }
  const { rows: [updated] } = await query(
    `UPDATE alert_events SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2 RETURNING *`, params
  );

  await query(
    `INSERT INTO alert_history (alert_event_id, user_id, action, from_status, to_status)
     VALUES ($1,$2,$3,$4,$5)`,
    [eventId, userId, action, (current as Record<string, unknown>).status, t.to]
  );
  return updated as Record<string, unknown>;
}

// ── Scheduled evaluation (deterministic alert types) ─────────────────────────

/** Evaluate active rules for one survey: S-01 (NPS drop) + V-03 (volume anomaly). */
export async function evaluateSurveyAlerts(orgId: string, surveyId: string): Promise<Array<Record<string, unknown>>> {
  const { rows: rules } = await query(
    `SELECT * FROM alert_rules
      WHERE org_id = $1 AND is_active = TRUE AND deleted_at IS NULL
        AND (survey_id = $2 OR survey_id IS NULL)`,
    [orgId, surveyId]
  );
  const fired: Array<Record<string, unknown>> = [];
  for (const rule of rules as AlertRule[]) {
    let event: Record<string, unknown> | null = null;
    if (rule.alert_type === 'S-01') event = await evalNpsDrop(rule, orgId, surveyId);
    else if (rule.alert_type === 'S-02') event = await evalNpsRise(rule, orgId, surveyId);
    else if (rule.alert_type === 'S-08') event = await evalPredictiveNps(rule, orgId, surveyId);
    else if (rule.alert_type === 'V-03') event = await evalVolumeAnomaly(rule, orgId, surveyId);
    if (event) fired.push(event);
  }
  return fired;
}

interface NpsWindows {
  cur: number | null;
  base: number | null;
}

// Shared current-vs-prior NPS computation over a window.
async function npsWindows(orgId: string, surveyId: string, windowDays: number): Promise<NpsWindows> {
  const { rows: current } = await query(
    `SELECT nps_score FROM responses
      WHERE survey_id = $1 AND org_id = $2 AND submitted_at >= NOW() - ($3 || ' days')::interval`,
    [surveyId, orgId, String(windowDays)]
  );
  const { rows: prior } = await query(
    `SELECT nps_score FROM responses
      WHERE survey_id = $1 AND org_id = $2
        AND submitted_at >= NOW() - ($3 || ' days')::interval
        AND submitted_at <  NOW() - ($4 || ' days')::interval`,
    [surveyId, orgId, String(windowDays * 2), String(windowDays)]
  );
  return { cur: computeNps(current as Array<{ nps_score?: number | null }>), base: computeNps(prior as Array<{ nps_score?: number | null }>) };
}

export async function evalNpsRise(rule: AlertRule, orgId: string, surveyId: string): Promise<Record<string, unknown> | null> {
  const cfg = (rule.threshold_config || {}) as Record<string, unknown>;
  const windowDays = (cfg.windowDays as number) || 7;
  const minRise = (cfg.minRise as number) ?? 5;
  const { cur, base } = await npsWindows(orgId, surveyId, windowDays);
  if (cur == null || base == null) return null;
  const rise = cur - base;
  if (rise < minRise) return null;
  return fireAlert(rule, {
    orgId, surveyId, severity: rule.severity || 'success',
    title: `NPS rose ${rise} points`,
    description: `NPS climbed from ${base} to ${cur} over the last ${windowDays} days.`,
    metricValue: cur, metricBaseline: base, metricChange: rise,
  });
}

export async function evalNpsDrop(rule: AlertRule, orgId: string, surveyId: string): Promise<Record<string, unknown> | null> {
  const cfg = (rule.threshold_config || {}) as Record<string, unknown>;
  const windowDays = (cfg.windowDays as number) || 7;
  const minDrop = (cfg.minDrop as number) ?? 5;

  const { rows: current } = await query(
    `SELECT nps_score FROM responses
      WHERE survey_id = $1 AND org_id = $2 AND submitted_at >= NOW() - ($3 || ' days')::interval`,
    [surveyId, orgId, String(windowDays)]
  );
  const { rows: prior } = await query(
    `SELECT nps_score FROM responses
      WHERE survey_id = $1 AND org_id = $2
        AND submitted_at >= NOW() - ($3 || ' days')::interval
        AND submitted_at <  NOW() - ($4 || ' days')::interval`,
    [surveyId, orgId, String(windowDays * 2), String(windowDays)]
  );
  const cur = computeNps(current as Array<{ nps_score?: number | null }>);
  const base = computeNps(prior as Array<{ nps_score?: number | null }>);
  if (cur == null || base == null) return null;
  const drop = base - cur;
  if (drop < minDrop) return null;

  return fireAlert(rule, {
    orgId, surveyId, severity: rule.severity || 'critical',
    title: `NPS dropped ${drop} points`,
    description: `NPS fell from ${base} to ${cur} over the last ${windowDays} days.`,
    metricValue: cur, metricBaseline: base, metricChange: -drop,
  });
}

export async function evalVolumeAnomaly(rule: AlertRule, orgId: string, surveyId: string): Promise<Record<string, unknown> | null> {
  const cfg = (rule.threshold_config || {}) as Record<string, unknown>;
  const { rows } = await query(
    `SELECT TO_CHAR(DATE_TRUNC('day', submitted_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
       FROM responses WHERE survey_id = $1 AND org_id = $2
        AND submitted_at >= NOW() - INTERVAL '14 days'
      GROUP BY 1 ORDER BY 1`,
    [surveyId, orgId]
  );
  if (rows.length < 6) return null;
  const series = (rows as Array<{ n: number }>).slice(0, -1).map((r) => r.n);
  const today = (rows as Array<{ n: number }>)[rows.length - 1].n;
  const { isAnomaly, z, mean } = detectAnomaly(series, today, { z: (cfg.z as number) || 3 });
  if (!isAnomaly) return null;

  return fireAlert(rule, {
    orgId, surveyId, severity: rule.severity || 'warning',
    title: `Response volume ${z > 0 ? 'spike' : 'drop'} detected`,
    description: `Today's volume (${today}) is ${z.toFixed(1)}σ from the ~${mean.toFixed(0)}/day baseline.`,
    metricValue: today, metricBaseline: Math.round(mean), metricChange: today - Math.round(mean),
  });
}

// Predictive alert (S-08): fire BEFORE the threshold is crossed. Uses the trend
// forecast — if NPS is currently above the floor but projected to fall below it
// within the horizon, raise a warning with the projected value + ETA.
export async function evalPredictiveNps(rule: AlertRule, orgId: string, surveyId: string): Promise<Record<string, unknown> | null> {
  const cfg = (rule.threshold_config || {}) as Record<string, unknown>;
  const floor = (cfg.below as number) ?? 30;
  const horizon = (cfg.horizon as number) ?? 7;

  const { rows } = await query(
    `SELECT nps FROM survey_metric_snapshots
      WHERE survey_id = $1 AND org_id = $2 AND nps IS NOT NULL
      ORDER BY captured_at ASC LIMIT 60`,
    [surveyId, orgId]
  );
  const series = (rows as Array<{ nps: unknown }>).map((r) => Number(r.nps));
  if (series.length < 3) return null;

  const current = series[series.length - 1];
  if (current < floor) return null; // already below — that's S-03's job, not predictive

  const fc = linearForecast(series, horizon);
  if (!fc || fc.direction !== 'down') return null;

  // First projected period that dips below the floor.
  const crossIdx = fc.points.findIndex((p) => p < floor);
  if (crossIdx === -1) return null;

  return fireAlert(rule, {
    orgId, surveyId, severity: rule.severity || 'warning',
    title: `NPS projected to fall below ${floor}`,
    description: `Crystal predicts NPS will dip below ${floor} in ~${crossIdx + 1} period(s) (now ${Math.round(current)}, trend falling).`,
    metricValue: current, metricBaseline: floor, metricChange: fc.points[crossIdx] - current,
    evidence: { forecast: fc.points, r2: fc.r2 },
  });
}

// Sweep all surveys that have active rules (called on the Event Engine schedule).
export async function runScheduledEvaluation(): Promise<number> {
  const { rows } = await query(
    `SELECT DISTINCT org_id, survey_id FROM alert_rules
      WHERE is_active = TRUE AND deleted_at IS NULL AND survey_id IS NOT NULL`
  );
  let fired = 0;
  for (const r of rows as Array<{ org_id: string; survey_id: string }>) {
    try { fired += (await evaluateSurveyAlerts(r.org_id, r.survey_id)).length; }
    catch { /* one survey's failure must not abort the sweep */ }
  }
  return fired;
}
