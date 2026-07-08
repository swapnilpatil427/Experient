// InsightSettingsPage — Insight Pipeline v2, Phase 5 (05_CONFIGURATION + 06_UX_DESIGN)
//
// /app/surveys/:surveyId/intelligence/settings
//
// Six sections (Automated, Refresh, Manual, Custom Analysis, Credits, Retention)
// rendered from a typed field schema. Shows the effective value plus where it
// comes from (survey override vs org default vs platform). Editable only for
// admins or the survey owner (backend `editable` flag + usePermissions). When
// locked, inputs are disabled with a lock icon + "ask your admin" hint.
//
// Save sends ONLY the changed keys via updateInsightSettings. Ranges are
// validated client-side mirroring the backend (05_CONFIGURATION §3, §10).
//
// A second tab edits org-wide defaults (admin only).

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useApi } from '../../hooks/useApi';
import { useAppAuth } from '../../lib/auth';
import { useTranslation } from '../../lib/i18n';
import { usePermissions } from '../../lib/permissions';
import { ROUTES, toPath } from '../../constants/routes';
import { getFeatureFlags } from '../../lib/features';
import { PageHeader } from '../../components/PageHeader';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { InsightSettings } from '../../types';

// ── Field schema ──────────────────────────────────────────────────────────────
// Each field maps a backend setting key to a UI control + validation range. The
// labelKey / helpKey resolve to surveyInsights.settings.<key> in locales/en.ts.
type FieldType = 'toggle' | 'int' | 'float' | 'credit';

interface FieldDef {
  key: string;
  type: FieldType;
  labelKey: string;
  helpKey: string;
  min?: number;
  max?: number;
  step?: number;
}

interface SectionDef {
  id: string;
  titleKey: string;
  descKey: string;
  fields: FieldDef[];
}

const f = (key: string, type: FieldType, labelKey: string, helpKey: string, min?: number, max?: number, step?: number): FieldDef =>
  ({ key, type, labelKey, helpKey, min, max, step });

export const SETTINGS_SECTIONS: SectionDef[] = [
  {
    id: 'automated',
    titleKey: 'sectionAutomated',
    descKey: 'sectionAutomatedDesc',
    fields: [
      f('automated_insights_enabled', 'toggle', 'automatedInsightsEnabled', 'automatedInsightsEnabledHelp'),
      f('automated_report_generation_enabled', 'toggle', 'automatedReportGenerationEnabled', 'automatedReportGenerationEnabledHelp'),
      f('stream_response_threshold', 'int', 'streamResponseThreshold', 'streamResponseThresholdHelp', 5, 500),
      f('response_tagging_batch_size', 'int', 'responseTaggingBatchSize', 'responseTaggingBatchSizeHelp', 1, 10),
      f('topic_discovery_candidate_threshold', 'int', 'topicDiscoveryCandidateThreshold', 'topicDiscoveryCandidateThresholdHelp', 5, 100),
      f('topic_discovery_min_cluster_size', 'int', 'topicDiscoveryMinClusterSize', 'topicDiscoveryMinClusterSizeHelp', 2, 20),
      f('report_regen_threshold', 'int', 'reportRegenThreshold', 'reportRegenThresholdHelp', 10, 200),
      f('prior_checkpoint_lookback', 'int', 'priorCheckpointLookback', 'priorCheckpointLookbackHelp', 1, 20),
      f('prior_checkpoint_max_age_days', 'int', 'priorCheckpointMaxAgeDays', 'priorCheckpointMaxAgeDaysHelp', 7, 365),
      f('full_checkpoint_response_threshold', 'int', 'fullCheckpointResponseThreshold', 'fullCheckpointResponseThresholdHelp', 50, 2000),
      f('meaningful_delta_nps_points', 'float', 'meaningfulDeltaNpsPoints', 'meaningfulDeltaNpsPointsHelp', 0.5, 10, 0.5),
      f('meaningful_delta_topic_pct', 'int', 'meaningfulDeltaTopicPct', 'meaningfulDeltaTopicPctHelp', 5, 25),
    ],
  },
  {
    id: 'refresh',
    titleKey: 'sectionRefresh',
    descKey: 'sectionRefreshDesc',
    fields: [
      f('refresh_lookback_days', 'int', 'refreshLookbackDays', 'refreshLookbackDaysHelp', 7, 365),
      f('refresh_min_response_count', 'int', 'refreshMinResponseCount', 'refreshMinResponseCountHelp', 5, 100),
      f('refresh_daily_limit', 'int', 'refreshDailyLimit', 'refreshDailyLimitHelp', 1, 20),
    ],
  },
  {
    id: 'manual',
    titleKey: 'sectionManual',
    descKey: 'sectionManualDesc',
    fields: [
      f('manual_daily_run_limit', 'int', 'manualDailyRunLimit', 'manualDailyRunLimitHelp', 1, 50),
      f('manual_expert_full_corpus_cap', 'int', 'manualExpertFullCorpusCap', 'manualExpertFullCorpusCapHelp', 100, 2000),
      f('manual_expert_max_corpus', 'int', 'manualExpertMaxCorpus', 'manualExpertMaxCorpusHelp', 500, 5000),
      f('manual_expert_snapshot_count', 'int', 'manualExpertSnapshotCount', 'manualExpertSnapshotCountHelp', 2, 10),
      f('manual_expert_checkpoint_lookback', 'int', 'manualExpertCheckpointLookback', 'manualExpertCheckpointLookbackHelp', 1, 10),
      f('manual_quick_sample_cap', 'int', 'manualQuickSampleCap', 'manualQuickSampleCapHelp', 50, 500),
      f('manual_quick_default_window_days', 'int', 'manualQuickDefaultWindowDays', 'manualQuickDefaultWindowDaysHelp', 7, 90),
    ],
  },
  {
    id: 'custom',
    titleKey: 'sectionCustom',
    descKey: 'sectionCustomDesc',
    fields: [
      f('custom_analysis_enabled', 'toggle', 'customAnalysisEnabled', 'customAnalysisEnabledHelp'),
      f('custom_analysis_daily_limit', 'int', 'customAnalysisDailyLimit', 'customAnalysisDailyLimitHelp', 1, 20),
      f('custom_analysis_max_corpus', 'int', 'customAnalysisMaxCorpus', 'customAnalysisMaxCorpusHelp', 500, 20000),
      f('custom_analysis_min_n_for_nps', 'int', 'customAnalysisMinNForNps', 'customAnalysisMinNForNpsHelp', 10, 100),
    ],
  },
  {
    id: 'credits',
    titleKey: 'sectionCredits',
    descKey: 'sectionCreditsDesc',
    fields: [
      f('credit_cost_automated', 'credit', 'creditCostAutomated', 'creditCostHelp', 1, 500),
      f('credit_cost_report', 'credit', 'creditCostReport', 'creditCostHelp', 1, 500),
      f('credit_cost_refresh', 'credit', 'creditCostRefresh', 'creditCostHelp', 1, 500),
      f('credit_cost_quick', 'credit', 'creditCostQuick', 'creditCostHelp', 1, 500),
      f('credit_cost_expert', 'credit', 'creditCostExpert', 'creditCostHelp', 1, 500),
      f('credit_cost_custom', 'credit', 'creditCostCustom', 'creditCostHelp', 1, 500),
    ],
  },
  {
    id: 'retention',
    titleKey: 'sectionRetention',
    descKey: 'sectionRetentionDesc',
    fields: [
      f('automated_checkpoint_retention_days', 'int', 'automatedCheckpointRetentionDays', 'automatedCheckpointRetentionDaysHelp', 1, 3650),
      f('collapse_similar_checkpoints', 'toggle', 'collapseSimilarCheckpoints', 'collapseSimilarCheckpointsHelp'),
      f('manual_report_retention_days', 'int', 'manualReportRetentionDays', 'manualReportRetentionDaysHelp', 1, 3650),
    ],
  },
];

const ALL_FIELDS: Record<string, FieldDef> = Object.fromEntries(
  SETTINGS_SECTIONS.flatMap((s) => s.fields.map((fld) => [fld.key, fld])),
);

// ── Validation ────────────────────────────────────────────────────────────────
function validateField(field: FieldDef, raw: unknown): string | null {
  if (field.type === 'toggle') return null;
  // Credit fields allow blank (= use org default).
  if (raw == null || raw === '') return field.type === 'credit' ? null : 'validationRequired';
  const n = Number(raw);
  if (Number.isNaN(n)) return field.type === 'credit' ? 'validationCreditCost' : 'validationRange';
  if (field.type === 'credit') {
    if (!Number.isInteger(n) || n < 1 || n > 500) return 'validationCreditCost';
    return null;
  }
  if (field.min != null && n < field.min) return 'validationRange';
  if (field.max != null && n > field.max) return 'validationRange';
  return null;
}

// Where does the effective value originate? (survey > org > platform)
function provenance(key: string, s: InsightSettings): 'survey' | 'org' | 'platform' {
  if (Object.prototype.hasOwnProperty.call(s.survey_overrides, key) && s.survey_overrides[key] != null) return 'survey';
  if (Object.prototype.hasOwnProperty.call(s.org_defaults, key) && s.org_defaults[key] != null) return 'org';
  return 'platform';
}

// ── Field row ─────────────────────────────────────────────────────────────────
function FieldRow({
  field,
  value,
  source,
  editable,
  error,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  source: 'survey' | 'org' | 'platform';
  editable: boolean;
  error: string | null;
  onChange: (v: unknown) => void;
}) {
  const { t } = useTranslation();
  const k = (suffix: string) => t(`surveyInsights.settings.${suffix}`);
  const sourceLabel =
    source === 'survey' ? k('sourceSurvey') : source === 'org' ? k('sourceOrg') : k('sourcePlatform');
  const sourceClr =
    source === 'survey' ? 'text-primary bg-primary/10' : source === 'org' ? 'text-amber-700 bg-amber-100' : 'text-muted-foreground bg-muted';

  return (
    <div className="py-3.5 border-t border-border first:border-t-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <label htmlFor={`set-${field.key}`} className="text-sm font-semibold text-on-surface">
              {k(field.labelKey)}
            </label>
            {!editable && <Icon name="lock" size={13} className="text-muted-foreground" />}
            <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded-full', sourceClr)}>
              {sourceLabel}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{k(field.helpKey)}</p>
          {field.type !== 'toggle' && field.min != null && field.max != null && (
            <p className="text-[11px] text-muted-foreground/70 mt-0.5 font-mono">
              {t('surveyInsights.settings.rangeHint', { min: field.min, max: field.max })}
            </p>
          )}
        </div>

        <div className="flex-shrink-0 w-32">
          {field.type === 'toggle' ? (
            <Switch
              id={`set-${field.key}`}
              checked={Boolean(value)}
              disabled={!editable}
              onCheckedChange={(c) => onChange(c)}
              aria-label={k(field.labelKey)}
            />
          ) : (
            <Input
              id={`set-${field.key}`}
              type="number"
              inputMode="decimal"
              value={value == null ? '' : String(value)}
              min={field.min}
              max={field.max}
              step={field.step ?? 1}
              disabled={!editable}
              onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
              className={cn('text-right', error && 'border-rose-400 focus-visible:ring-rose-400')}
              aria-invalid={!!error}
            />
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-[11px] text-rose-600 mt-1.5">
          {error === 'validationCreditCost'
            ? k('validationCreditCost')
            : error === 'validationRequired'
              ? k('validationRequired')
              : t('surveyInsights.settings.validationRange', { min: field.min ?? '', max: field.max ?? '' })}
        </p>
      )}
    </div>
  );
}

// ── Section card ──────────────────────────────────────────────────────────────
function SectionCard({
  section,
  children,
}: {
  section: SectionDef;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <h2 className="text-base font-bold text-on-surface">{t(`surveyInsights.settings.${section.titleKey}`)}</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-2">{t(`surveyInsights.settings.${section.descKey}`)}</p>
      <div>{children}</div>
    </section>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function InsightSettingsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const { orgId } = useAppAuth();
  const { isAdmin } = usePermissions();
  const { surveyId } = useParams<{ surveyId: string }>();
  useSetPageTitle(t('surveyInsights.settings.title'), t('surveyInsights.settings.subtitle'));

  const [tab, setTab] = useState<'survey' | 'org'>('survey');

  const [settings, setSettings] = useState<InsightSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Working copy of changed values keyed by setting key (survey tab).
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState(false);

  // Org defaults tab
  const [orgDefaults, setOrgDefaults] = useState<Record<string, unknown>>({});
  const [orgDraft, setOrgDraft] = useState<Record<string, unknown>>({});
  const [orgLoaded, setOrgLoaded] = useState(false);

  const coerce = (v: unknown): number | null =>
    v == null ? null : Number.isNaN(Number(v)) ? null : Number(v);

  const load = useCallback(() => {
    if (!surveyId) return;
    setLoading(true);
    setError(false);
    api.getInsightSettings(surveyId)
      .then((s) => { setSettings(s); setDraft({}); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [api, surveyId]);

  useEffect(() => { load(); }, [load]);

  // Lazy-load org defaults when the admin opens the org tab.
  useEffect(() => {
    if (tab !== 'org' || orgLoaded || !orgId) return;
    api.getOrgInsightDefaults(orgId)
      .then((d) => { setOrgDefaults(d.defaults); setOrgLoaded(true); })
      .catch(() => setOrgLoaded(true));
  }, [tab, orgLoaded, orgId, api]);

  const editable = (settings?.editable ?? false);

  // Resolve the value shown for a field: draft override → effective.
  const valueFor = useCallback((key: string): unknown => {
    if (Object.prototype.hasOwnProperty.call(draft, key)) return draft[key];
    return settings?.effective[key];
  }, [draft, settings]);

  const setField = useCallback((key: string, v: unknown) => {
    setDraft((prev) => ({ ...prev, [key]: v }));
    setSavedFlash(false);
  }, []);

  // Validate the whole draft.
  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [key, v] of Object.entries(draft)) {
      const field = ALL_FIELDS[key];
      if (!field) continue;
      const e = validateField(field, v);
      if (e) out[key] = e;
    }
    return out;
  }, [draft]);

  // Only keys that actually differ from the effective value, coerced to typed values.
  const changedPatch = useMemo(() => {
    if (!settings) return {} as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(draft)) {
      const field = ALL_FIELDS[key];
      if (!field) continue;
      const eff = settings.effective[key];
      let coerced: unknown = v;
      if (field.type === 'toggle') coerced = Boolean(v);
      else if (v === '' || v == null) coerced = null;
      else coerced = field.type === 'float' ? Number(v) : Number(v);
      // Skip no-ops (string vs number compare via loose equality on value).
      if (coerced === eff) continue;
      if (coerced != null && eff != null && Number(coerced) === Number(eff) && field.type !== 'toggle') continue;
      patch[key] = coerced;
    }
    return patch;
  }, [draft, settings]);

  const hasChanges = Object.keys(changedPatch).length > 0;
  const hasErrors = Object.keys(errors).length > 0;

  const handleSave = useCallback(async () => {
    if (!surveyId || !hasChanges || hasErrors) return;
    setSaving(true);
    setSaveError(false);
    try {
      const res = await api.updateInsightSettings(surveyId, changedPatch);
      // Merge the new overrides back into settings so provenance updates.
      setSettings((prev) => prev ? { ...prev, survey_overrides: res.survey_overrides, config_version: res.config_version, config_hash: res.config_hash } : prev);
      setDraft({});
      setSavedFlash(true);
      // Refetch to get the recomputed effective merge.
      load();
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }, [api, surveyId, hasChanges, hasErrors, changedPatch, load]);

  // Cross-field soft warnings (non-blocking).
  const warnings = useMemo(() => {
    const out: string[] = [];
    if (!settings) return out;
    const stream = coerce(valueFor('stream_response_threshold')) ?? NaN;
    const regen = coerce(valueFor('report_regen_threshold')) ?? NaN;
    if (!Number.isNaN(stream) && !Number.isNaN(regen) && stream >= regen) out.push('validationStreamVsRegen');
    const cap = coerce(valueFor('manual_expert_full_corpus_cap')) ?? NaN;
    const max = coerce(valueFor('manual_expert_max_corpus')) ?? NaN;
    if (!Number.isNaN(cap) && !Number.isNaN(max) && max < cap) out.push('validationCorpusOrder');
    return out;
  }, [settings, valueFor]);

  // ── Org defaults editing (admin only) ──
  const orgEditable = isAdmin;
  const setOrgField = useCallback((key: string, v: unknown) => {
    setOrgDraft((prev) => ({ ...prev, [key]: v }));
  }, []);
  const orgValueFor = useCallback((key: string): unknown => {
    if (Object.prototype.hasOwnProperty.call(orgDraft, key)) return orgDraft[key];
    return orgDefaults[key];
  }, [orgDraft, orgDefaults]);
  const orgErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [key, v] of Object.entries(orgDraft)) {
      const field = ALL_FIELDS[key];
      if (!field) continue;
      const e = validateField(field, v);
      if (e) out[key] = e;
    }
    return out;
  }, [orgDraft]);
  const orgChanged = Object.keys(orgDraft).length > 0;
  const [orgSaving, setOrgSaving] = useState(false);
  const [orgSaved, setOrgSaved] = useState(false);
  const handleOrgSave = useCallback(async () => {
    if (!orgId || !orgChanged || Object.keys(orgErrors).length > 0) return;
    setOrgSaving(true);
    try {
      const patch: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(orgDraft)) {
        const field = ALL_FIELDS[key];
        if (!field) continue;
        patch[key] = field.type === 'toggle' ? Boolean(v) : v === '' || v == null ? null : Number(v);
      }
      const res = await api.updateOrgInsightDefaults(orgId, patch);
      setOrgDefaults(res.defaults);
      setOrgDraft({});
      setOrgSaved(true);
    } catch {
      /* surfaced via banner */
    } finally {
      setOrgSaving(false);
    }
  }, [api, orgId, orgChanged, orgErrors, orgDraft]);

  // Feature flag guard — placed after all hook calls to satisfy React's Rules of Hooks
  const { insightsTrajectoryV1 } = getFeatureFlags();
  if (!insightsTrajectoryV1) return <Navigate to={ROUTES.INSIGHTS} replace />;

  return (
    <div className="max-w-3xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: t('surveyInsights.settings.back'), path: toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId: surveyId ?? '' }) },
          { label: t('surveyInsights.settings.title') },
        ]}
        title={t('surveyInsights.settings.title')}
        subtitle={t('surveyInsights.settings.subtitle')}
      />

      {/* Tabs */}
      <div className="flex items-center gap-2 mb-5">
        <button
          type="button"
          onClick={() => setTab('survey')}
          aria-pressed={tab === 'survey'}
          className={cn('px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors',
            tab === 'survey' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/50')}
        >
          {t('surveyInsights.settings.tabSurvey')}
        </button>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setTab('org')}
            aria-pressed={tab === 'org'}
            className={cn('px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors',
              tab === 'org' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/50')}
          >
            {t('surveyInsights.settings.tabOrg')}
          </button>
        )}
      </div>

      {/* ── Survey tab ── */}
      {tab === 'survey' && (
        loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => <div key={i} className="animate-pulse rounded-2xl bg-muted h-40" />)}
          </div>
        ) : error || !settings ? (
          <div className="text-center py-16">
            <Icon name="error" size={32} className="text-muted-foreground mx-auto" />
            <div className="font-semibold mt-3">{t('surveyInsights.settings.errorTitle')}</div>
            <p className="text-sm text-muted-foreground mt-1">{t('surveyInsights.settings.errorBody')}</p>
            <Button size="sm" variant="outline" className="mt-4" onClick={load}>
              {t('surveyInsights.settings.retry')}
            </Button>
          </div>
        ) : (
          <>
            {/* Lock banner for non-editors */}
            {!editable && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 mb-5 flex items-center gap-2 text-sm text-amber-800">
                <Icon name="lock" size={16} />
                <span>{t('surveyInsights.settings.lockHint')} {t('surveyInsights.settings.askAdmin')}</span>
              </div>
            )}

            <div className="space-y-5">
              {SETTINGS_SECTIONS.map((section) => (
                <SectionCard key={section.id} section={section}>
                  {section.fields.map((field) => (
                    <FieldRow
                      key={field.key}
                      field={field}
                      value={valueFor(field.key)}
                      source={provenance(field.key, settings)}
                      editable={editable}
                      error={errors[field.key] ?? null}
                      onChange={(v) => setField(field.key, v)}
                    />
                  ))}
                </SectionCard>
              ))}
            </div>

            {/* Soft warnings */}
            {warnings.length > 0 && (
              <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 space-y-1">
                {warnings.map((w) => <div key={w}>{t(`surveyInsights.settings.${w}`)}</div>)}
              </div>
            )}

            {/* Save bar */}
            {editable && (
              <div className="sticky bottom-4 mt-6 flex items-center justify-end gap-3 rounded-2xl border border-border bg-card/95 backdrop-blur px-4 py-3 shadow-lg">
                {saveError && <span className="text-sm text-rose-600 mr-auto">{t('surveyInsights.settings.saveError')}</span>}
                {savedFlash && !hasChanges && <span className="text-sm text-emerald-600 mr-auto">{t('surveyInsights.settings.saved')}</span>}
                {hasChanges && <span className="text-sm text-muted-foreground mr-auto">{t('surveyInsights.settings.unsavedChanges')}</span>}
                <Button onClick={handleSave} disabled={!hasChanges || hasErrors || saving}>
                  {saving ? t('surveyInsights.settings.saving') : t('surveyInsights.settings.save')}
                </Button>
              </div>
            )}
          </>
        )
      )}

      {/* ── Org defaults tab (admin only) ── */}
      {tab === 'org' && isAdmin && (
        <>
          <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 mb-5">
            <div className="font-semibold text-sm">{t('surveyInsights.settings.orgTitle')}</div>
            <p className="text-xs text-muted-foreground mt-0.5">{t('surveyInsights.settings.orgSubtitle')}</p>
          </div>
          {!orgEditable && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 mb-5 text-sm text-amber-800">
              {t('surveyInsights.settings.orgAdminOnly')}
            </div>
          )}
          <div className="space-y-5">
            {SETTINGS_SECTIONS.map((section) => (
              <SectionCard key={section.id} section={section}>
                {section.fields.map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    value={orgValueFor(field.key)}
                    source="org"
                    editable={orgEditable}
                    error={orgErrors[field.key] ?? null}
                    onChange={(v) => setOrgField(field.key, v)}
                  />
                ))}
              </SectionCard>
            ))}
          </div>
          {orgEditable && (
            <div className="sticky bottom-4 mt-6 flex items-center justify-end gap-3 rounded-2xl border border-border bg-card/95 backdrop-blur px-4 py-3 shadow-lg">
              {orgSaved && !orgChanged && <span className="text-sm text-emerald-600 mr-auto">{t('surveyInsights.settings.saved')}</span>}
              <Button onClick={handleOrgSave} disabled={!orgChanged || Object.keys(orgErrors).length > 0 || orgSaving}>
                {orgSaving ? t('surveyInsights.settings.saving') : t('surveyInsights.settings.save')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
