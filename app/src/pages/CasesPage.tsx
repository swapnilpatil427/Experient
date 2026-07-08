import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useApi } from '../hooks/useApi';
import { useTranslation } from '../lib/i18n';
import { useInvalidation } from '../lib/dataBus';
import { ROUTES, toPath } from '../constants/routes';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CxCase, CaseSeverity, CaseStatus } from '../types';

const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.06 } } };
const rise = {
  hidden:  { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

const SEVERITY_COLORS: Record<CaseSeverity, { dot: string; badge: string; text: string; border: string; bg: string }> = {
  critical: { dot: 'bg-red-500',     badge: 'rgba(220,38,38,0.1)',   text: '#dc2626', border: '#dc2626', bg: '#fef2f2' },
  high:     { dot: 'bg-amber-500',   badge: 'rgba(217,119,6,0.1)',   text: '#d97706', border: '#d97706', bg: '#fffbeb' },
  medium:   { dot: 'bg-blue-500',    badge: 'rgba(42,75,217,0.1)',   text: '#2a4bd9', border: '#2a4bd9', bg: '#eff6ff' },
  low:      { dot: 'bg-emerald-500', badge: 'rgba(5,150,105,0.1)',   text: '#059669', border: '#059669', bg: '#f0fdf4' },
};

const STATUS_COLORS: Record<CaseStatus, { bg: string; text: string; dotClass?: string; pulse?: boolean }> = {
  open:        { bg: 'rgba(42,75,217,0.1)',   text: '#2a4bd9',  dotClass: 'bg-blue-500' },
  in_progress: { bg: 'rgba(217,119,6,0.1)',   text: '#d97706',  dotClass: 'bg-amber-500' },
  escalated:   { bg: 'rgba(220,38,38,0.1)',   text: '#dc2626',  dotClass: 'bg-red-500',     pulse: true },
  resolved:    { bg: 'rgba(5,150,105,0.1)',   text: '#059669',  dotClass: 'bg-emerald-500' },
  closed:      { bg: 'rgba(107,114,128,0.1)', text: '#6b7280',  dotClass: 'bg-gray-400' },
};

/** Returns a human-readable countdown string and a color based on remaining SLA time. */
function useSlaCountdown(resolveDueAt: string | null | undefined) {
  const [display, setDisplay] = useState({ label: '', color: '#6b7280', totalHours: 999 });

  useEffect(() => {
    if (!resolveDueAt) return;

    function compute() {
      if (!resolveDueAt) return;
      const now = Date.now();
      const due = new Date(resolveDueAt).getTime();
      const diffMs = due - now;

      if (diffMs <= 0) {
        setDisplay({ label: '', color: '#dc2626', totalHours: 0 });
        return;
      }

      const totalHours = diffMs / 1000 / 3600;
      const hours = Math.floor(totalHours);
      const minutes = Math.floor((diffMs / 1000 / 60) % 60);
      const label = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      // Color coding: red < 2h, amber 2-8h, green > 8h
      const color = totalHours < 2 ? '#dc2626' : totalHours < 8 ? '#d97706' : '#059669';
      setDisplay({ label, color, totalHours });
    }

    compute();
    const timer = setInterval(compute, 60_000);
    return () => clearInterval(timer);
  }, [resolveDueAt]);

  return display;
}

function SlaChip({ resolveDueAt, breached }: { resolveDueAt?: string | null; breached: boolean }) {
  const { t } = useTranslation();
  const { label, color } = useSlaCountdown(resolveDueAt);

  if (breached) {
    return (
      <span
        className="text-[11px] font-bold px-2 py-1 inline-flex items-center gap-0.5"
        style={{
          background: 'rgba(220,38,38,0.08)',
          color: '#dc2626',
          border: '1px solid rgba(220,38,38,0.3)',
          borderRadius: '0.5rem',
        }}
      >
        <Icon name="schedule" size={11} className="inline mr-0.5" />
        {t('cases.slaBreached')}
      </span>
    );
  }
  if (!label) return null;
  return (
    <span
      className="text-[11px] font-bold px-2 py-1 inline-flex items-center gap-0.5"
      style={{
        background: `${color}14`,
        color,
        border: `1px solid ${color}30`,
        borderRadius: '0.5rem',
      }}
    >
      <Icon name="schedule" size={11} className="inline mr-0.5" />
      {t('cases.slaCountdown', { time: label })}
    </span>
  );
}

function OwnerAvatar({ label }: { label?: string | null }) {
  const { t } = useTranslation();
  if (!label) return (
    <span className="text-xs text-on-surface-variant italic">{t('cases.noOwner')}</span>
  );
  const initials = label.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="flex items-center gap-1.5">
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
        style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
      >
        {initials}
      </div>
      <span className="text-xs text-on-surface-variant truncate max-w-[80px]">{label}</span>
    </div>
  );
}

function CaseCard({ cxCase }: { cxCase: CxCase }) {
  const { t } = useTranslation();
  const sev = SEVERITY_COLORS[cxCase.severity] ?? SEVERITY_COLORS.medium;
  const st = STATUS_COLORS[cxCase.status] ?? STATUS_COLORS.open;

  const glassBase: React.CSSProperties = {
    background: 'rgba(255,255,255,0.72)',
    backdropFilter: 'blur(32px) saturate(180%)',
    border: '1px solid rgba(255,255,255,0.6)',
    boxShadow: '0 4px 24px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.8)',
    borderRadius: '1rem',
    borderLeft: `4px solid ${sev.border}`,
  };

  const glassHover: React.CSSProperties = {
    boxShadow: `0 20px 40px -8px color-mix(in srgb, var(--color-primary) 14%, transparent), inset 0 1px 0 rgba(255,255,255,0.8)`,
    transform: 'perspective(1000px) rotateX(2deg) rotateY(-1deg)',
  };

  return (
    <motion.div variants={rise}>
      <div
        className="group relative overflow-hidden transition-all duration-300"
        style={glassBase}
        onMouseEnter={(e) => {
          Object.assign(e.currentTarget.style, glassHover);
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.boxShadow = glassBase.boxShadow as string;
          e.currentTarget.style.transform = '';
        }}
      >
        <div className="flex flex-col md:flex-row items-start md:items-center gap-4 p-5">
          {/* Left: severity dot + title */}
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div
              className={`mt-1 w-2.5 h-2.5 rounded-full shrink-0 ${sev.dot}`}
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span
                  className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
                  style={{ background: sev.bg, color: sev.text, border: `1px solid ${sev.border}30` }}
                >
                  {t(`cases.severity.${cxCase.severity}`)}
                </span>
                {cxCase.driver_ref && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-surface-container text-on-surface-variant">
                    <Icon name="tune" size={10} className="inline mr-0.5" />
                    {cxCase.driver_ref}
                  </span>
                )}
              </div>
              <p className="font-bold text-on-surface truncate">{cxCase.title}</p>
              <p className="text-xs text-on-surface-variant mt-0.5">
                {cxCase.contact?.name ?? (cxCase.contact_id ? t('cases.linkedContact') : t('cases.unlinkedContact'))}
              </p>
            </div>
          </div>

          {/* Center: SLA + owner */}
          <div className="flex flex-col gap-1.5 md:items-center">
            <SlaChip resolveDueAt={cxCase.resolve_due_at} breached={cxCase.sla_breached} />
            <OwnerAvatar label={cxCase.owner_label} />
          </div>

          {/* Right: status badge + view link */}
          <div className="flex items-center gap-3 shrink-0">
            <span
              className="text-[11px] font-bold px-2.5 py-1 rounded-full inline-flex items-center gap-1.5"
              style={{ background: st.bg, color: st.text }}
            >
              {st.dotClass && (
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${st.dotClass}`}
                  style={st.pulse ? { animation: 'pulse-glow 1.5s ease-in-out infinite' } : undefined}
                />
              )}
              {t(`cases.status.${cxCase.status}`)}
            </span>
            <Link
              to={toPath(ROUTES.CASE_DETAIL, { caseId: cxCase.id })}
              className="text-xs font-bold px-3 py-1.5 rounded-lg transition-all hover:opacity-90"
              style={{
                background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)',
                color: 'var(--color-primary)',
                border: '1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)',
              }}
            >
              {t('cases.viewCase')}
            </Link>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function SkeletonCard() {
  return (
    <div
      className="p-5"
      style={{
        background: 'rgba(255,255,255,0.72)',
        backdropFilter: 'blur(32px) saturate(180%)',
        border: '1px solid rgba(255,255,255,0.6)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.05)',
        borderRadius: '1rem',
        borderLeft: '4px solid color-mix(in srgb, var(--color-primary) 15%, transparent)',
      }}
    >
      <div className="flex items-center gap-4">
        <div className="skeleton w-2.5 h-2.5 rounded-full" />
        <div className="flex-1 space-y-2">
          <div className="skeleton h-4 rounded w-1/2" />
          <div className="skeleton h-3 rounded w-1/3" />
        </div>
        <div className="skeleton h-5 w-20 rounded-full" />
      </div>
    </div>
  );
}

const STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'all',         label: 'cases.filterAll' },
  { key: 'open',        label: 'cases.status.open' },
  { key: 'in_progress', label: 'cases.status.in_progress' },
  { key: 'escalated',   label: 'cases.status.escalated' },
  { key: 'resolved',    label: 'cases.status.resolved' },
];

export function CasesPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('cases.title'), t('cases.subtitle'));
  const api = useApi();

  const [cases, setCases] = useState<CxCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusTab, setStatusTab] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [slaDashboard, setSlaDashboard] = useState<{ open_count: number; at_risk_count: number; breached_count: number; by_severity: Record<string, number> } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadCases = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (statusTab !== 'all')  params.status   = statusTab;
      if (severity !== 'all')   params.severity = severity;
      const result = await api.listCases(params);
      setCases(result.cases);
    } catch {
      setCases([]);
    } finally {
      setLoading(false);
    }
  }, [api, statusTab, severity]);

  useEffect(() => { loadCases(); }, [loadCases]);

  useEffect(() => {
    api.getSlaDashboard().then(setSlaDashboard).catch(() => {});
  }, [api]);

  useInvalidation('cases', loadCases);

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[{ label: t('cases.title'), icon: 'work', path: ROUTES.CASES }]}
        title={t('cases.title')}
        subtitle={t('cases.subtitle')}
        actions={
          <Button
            className="font-bold text-sm text-white rounded-xl px-5 py-2.5"
            style={{ background: 'var(--color-primary)' }}
          >
            <Icon name="add" size={16} className="mr-1.5" />
            {t('cases.createCase')}
          </Button>
        }
      />

      {/* X+O Intelligence Banner */}
      <AnimatePresence>
        {slaDashboard && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            style={{
              background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 8%, transparent) 0%, color-mix(in srgb, var(--color-tertiary) 6%, transparent) 50%, color-mix(in srgb, var(--color-secondary) 5%, transparent) 100%)',
              border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)',
              borderRadius: '1.25rem',
              padding: '1.25rem 1.5rem',
              backdropFilter: 'blur(20px)',
            }}
            className="mb-6"
          >
            {/* X+O Active header row */}
            <div className="flex items-center gap-2 mb-3">
              <span
                className="w-2 h-2 rounded-full bg-emerald-500"
                style={{ animation: 'pulse-glow 2.5s ease-in-out infinite' }}
              />
              <span
                className="text-[10px] font-black uppercase tracking-widest"
                style={{ color: 'var(--color-primary)' }}
              >
                X+O Active
              </span>
              <div className="h-px flex-1" style={{ background: 'color-mix(in srgb, var(--color-primary) 12%, transparent)' }} />
            </div>

            {/* Metric chips */}
            <div className="flex flex-wrap gap-3">
              {/* Critical — breached */}
              {slaDashboard.breached_count > 0 && (
                <div
                  className="flex items-center gap-2 px-3 py-2 rounded-xl"
                  style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)' }}
                >
                  <span
                    className="w-2 h-2 rounded-full bg-red-500"
                    style={{ animation: 'pulse-glow 1.5s ease-in-out infinite' }}
                  />
                  <span className="text-sm font-black" style={{ color: '#dc2626' }}>
                    {slaDashboard.breached_count}
                  </span>
                  <span className="text-xs text-on-surface-variant font-medium">{t('cases.breached')}</span>
                </div>
              )}

              {/* At risk */}
              {slaDashboard.at_risk_count > 0 && (
                <div
                  className="flex items-center gap-2 px-3 py-2 rounded-xl"
                  style={{ background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.2)' }}
                >
                  <span className="w-2 h-2 rounded-full bg-amber-500" />
                  <span className="text-sm font-black" style={{ color: '#d97706' }}>
                    {slaDashboard.at_risk_count}
                  </span>
                  <span className="text-xs text-on-surface-variant font-medium">{t('cases.atRisk')}</span>
                </div>
              )}

              {/* Open cases */}
              <div
                className="flex items-center gap-2 px-3 py-2 rounded-xl"
                style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }}
              >
                <Icon name="work" size={14} style={{ color: 'var(--color-primary)' }} />
                <span className="text-sm font-black" style={{ color: 'var(--color-primary)' }}>
                  {slaDashboard.open_count}
                </span>
                <span className="text-xs text-on-surface-variant font-medium">{t('cases.openCases')}</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Filter bar */}
      <div className="flex flex-col md:flex-row gap-3 mb-6">
        {/* Status tabs — pill-shaped container */}
        <div
          className="flex gap-1"
          style={{
            background: 'rgba(255,255,255,0.6)',
            border: '1px solid color-mix(in srgb, var(--color-primary) 10%, transparent)',
            borderRadius: '0.875rem',
            padding: '0.25rem',
          }}
        >
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setStatusTab(tab.key)}
              className="px-3 py-1.5 text-xs font-semibold transition-all duration-200"
              style={
                statusTab === tab.key
                  ? {
                      background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
                      color: '#ffffff',
                      borderRadius: '0.625rem',
                    }
                  : {
                      background: 'transparent',
                      color: 'var(--color-on-surface-variant, #6b7280)',
                      borderRadius: '0.625rem',
                    }
              }
            >
              {t(tab.label)}
            </button>
          ))}
        </div>

        {/* Severity filter */}
        <Select value={severity} onValueChange={setSeverity}>
          <SelectTrigger className="w-36 rounded-xl border-0" style={{ background: 'rgba(255,255,255,0.6)', border: '1px solid color-mix(in srgb, var(--color-primary) 10%, transparent)' }}>
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            <SelectItem value="critical">{t('cases.severity.critical')}</SelectItem>
            <SelectItem value="high">{t('cases.severity.high')}</SelectItem>
            <SelectItem value="medium">{t('cases.severity.medium')}</SelectItem>
            <SelectItem value="low">{t('cases.severity.low')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Loading skeletons */}
      {loading && (
        <div className="flex flex-col gap-3" aria-label={t('cases.skeletonAria')}>
          {[0, 1, 2].map((i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {/* Cases list */}
      {!loading && cases.length > 0 && (
        <motion.div
          className="flex flex-col gap-3"
          variants={stagger}
          initial="hidden"
          animate="visible"
        >
          {cases.map((c) => <CaseCard key={c.id} cxCase={c} />)}
        </motion.div>
      )}

      {/* Empty state */}
      {!loading && cases.length === 0 && (
        <motion.div
          className="text-center py-20"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{
              background: 'rgba(255,255,255,0.72)',
              backdropFilter: 'blur(32px) saturate(180%)',
              border: '1px solid rgba(255,255,255,0.6)',
              boxShadow: '0 4px 24px rgba(0,0,0,0.05)',
            }}
          >
            <Icon name="work" size={32} className="text-on-surface-variant" />
          </div>
          <h3 className="text-xl font-bold mb-2 font-headline text-on-surface">{t('cases.noCases')}</h3>
          <p className="text-sm text-on-surface-variant max-w-sm mx-auto">{t('cases.noCasesDescription')}</p>
        </motion.div>
      )}
    </div>
  );
}
