import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useApi } from '../hooks/useApi';
import { useTranslation } from '../lib/i18n';
import { invalidate } from '../lib/dataBus';
import { ROUTES, toPath } from '../constants/routes';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CxCase, CaseStatus, CaseSeverity, CaseAuditEntry } from '../types';

const STATUS_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  open:        ['in_progress', 'escalated', 'resolved', 'closed'],
  in_progress: ['escalated', 'resolved', 'closed'],
  escalated:   ['in_progress', 'resolved', 'closed'],
  resolved:    ['closed', 'open'],
  closed:      ['open'],
};

const SEVERITY_COLORS: Record<CaseSeverity, { bg: string; text: string; border: string; dotClass: string }> = {
  critical: { bg: '#fef2f2',  text: '#dc2626', border: '#dc2626', dotClass: 'bg-red-500' },
  high:     { bg: '#fffbeb',  text: '#d97706', border: '#d97706', dotClass: 'bg-amber-500' },
  medium:   { bg: '#eff6ff',  text: '#2a4bd9', border: '#2a4bd9', dotClass: 'bg-blue-500' },
  low:      { bg: '#f0fdf4',  text: '#059669', border: '#059669', dotClass: 'bg-emerald-500' },
};

const STATUS_COLORS: Record<CaseStatus, { bg: string; text: string }> = {
  open:        { bg: 'rgba(42,75,217,0.1)',   text: '#2a4bd9' },
  in_progress: { bg: 'rgba(217,119,6,0.1)',   text: '#d97706' },
  escalated:   { bg: 'rgba(220,38,38,0.1)',   text: '#dc2626' },
  resolved:    { bg: 'rgba(5,150,105,0.1)',   text: '#059669' },
  closed:      { bg: 'rgba(107,114,128,0.1)', text: '#6b7280' },
};

const STATUS_STEP_ORDER: CaseStatus[] = ['open', 'in_progress', 'escalated', 'resolved'];

const glassmorphism = {
  background: 'rgba(255,255,255,0.72)',
  backdropFilter: 'blur(32px) saturate(180%)',
  WebkitBackdropFilter: 'blur(32px) saturate(180%)',
  border: '1px solid rgba(255,255,255,0.6)',
  boxShadow: '0 4px 24px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.8)',
  borderRadius: '1rem',
} as const;

function SlaRing({ resolveDueAt, breached }: { resolveDueAt?: string | null; breached: boolean }) {
  const [pct, setPct] = useState(100);

  useEffect(() => {
    if (!resolveDueAt) return;
    function compute() {
      if (!resolveDueAt) return;
      const totalWindow = 72 * 3600 * 1000; // 72h window
      const due = new Date(resolveDueAt).getTime();
      const created = due - totalWindow;
      const now = Date.now();
      const remaining = due - now;
      if (remaining <= 0) { setPct(0); return; }
      const elapsed = now - created;
      const p = Math.max(0, Math.min(100, (1 - elapsed / totalWindow) * 100));
      setPct(p);
    }
    compute();
    const id = setInterval(compute, 60000);
    return () => clearInterval(id);
  }, [resolveDueAt]);

  const color = breached ? '#dc2626' : pct < 15 ? '#dc2626' : pct < 35 ? '#d97706' : '#059669';
  const r = 24, stroke = 4, circ = 2 * Math.PI * r;

  return (
    <div className="flex items-center gap-3">
      <svg width="60" height="60" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="30" cy="30" r={r} fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth={stroke} />
        <circle
          cx="30" cy="30" r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={circ} strokeDashoffset={circ * (1 - (breached ? 0 : pct) / 100)}
          strokeLinecap="round" style={{ transition: 'stroke-dashoffset 0.5s ease' }}
        />
      </svg>
      <div>
        <div className="text-xs font-bold" style={{ color }}>{breached ? 'Breached' : `${Math.round(pct)}%`}</div>
        <div className="text-[10px] text-on-surface-variant">SLA remaining</div>
      </div>
    </div>
  );
}

function SlaTimerBadge({ resolveDueAt, breached }: { resolveDueAt?: string | null; breached: boolean }) {
  const { t } = useTranslation();
  const [label, setLabel] = useState('');
  const [color, setColor] = useState('#6b7280');

  useEffect(() => {
    if (!resolveDueAt) return;
    function tick() {
      if (!resolveDueAt) return;
      const diffMs = new Date(resolveDueAt).getTime() - Date.now();
      if (diffMs <= 0) { setLabel(t('cases.slaBreached')); setColor('#dc2626'); return; }
      const h = Math.floor(diffMs / 3600000);
      const m = Math.floor((diffMs % 3600000) / 60000);
      setLabel(h > 0 ? `${h}h ${m}m` : `${m}m`);
      setColor(diffMs < 7200000 ? '#dc2626' : diffMs < 28800000 ? '#d97706' : '#059669');
    }
    tick();
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, [resolveDueAt, t]);

  if (breached) return (
    <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: 'rgba(220,38,38,0.1)', color: '#dc2626' }}>
      <Icon name="schedule" size={12} className="inline mr-0.5" />
      {t('cases.slaBreached')}
    </span>
  );
  if (!label) return null;
  return (
    <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: `${color}18`, color }}>
      <Icon name="schedule" size={12} className="inline mr-0.5" />
      {t('cases.slaCountdown', { time: label })}
    </span>
  );
}

function StatusStepper({ status }: { status: CaseStatus }) {
  const { t } = useTranslation();
  const currentIdx = STATUS_STEP_ORDER.indexOf(status);

  return (
    <div className="flex items-center gap-0 w-full">
      {STATUS_STEP_ORDER.map((s, i) => {
        const isDone = i < currentIdx;
        const isActive = i === currentIdx;
        const isFuture = i > currentIdx;
        const st = STATUS_COLORS[s];
        return (
          <div key={s} className="flex items-center flex-1 min-w-0">
            <div className="flex flex-col items-center min-w-0" style={{ flex: 1 }}>
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-all duration-300"
                style={{
                  background: isDone ? '#059669' : isActive ? `linear-gradient(135deg, var(--color-primary), var(--color-tertiary))` : 'rgba(0,0,0,0.06)',
                  boxShadow: isActive ? `0 0 0 3px ${st.bg}` : undefined,
                }}
              >
                {isDone ? (
                  <Icon name="check" size={12} className="text-white" />
                ) : (
                  <span className="text-[9px] font-bold" style={{ color: isActive ? '#fff' : isFuture ? '#9ca3af' : '#fff' }}>{i + 1}</span>
                )}
              </div>
              <span
                className="text-[9px] font-semibold mt-1 text-center leading-tight truncate w-full"
                style={{ color: isDone ? '#059669' : isActive ? st.text : '#9ca3af' }}
              >
                {t(`cases.status.${s}`)}
              </span>
            </div>
            {i < STATUS_STEP_ORDER.length - 1 && (
              <div
                className="h-[2px] flex-1 mx-1 rounded-full transition-all duration-500"
                style={{
                  background: isDone
                    ? 'linear-gradient(90deg, #059669, #34d399)'
                    : isActive
                    ? `linear-gradient(90deg, var(--color-primary), color-mix(in srgb, var(--color-primary) 10%, transparent))`
                    : 'rgba(0,0,0,0.06)',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function OwnerCard({ ownerLabel }: { ownerLabel?: string | null }) {
  const { t } = useTranslation();
  const initials = ownerLabel
    ? ownerLabel.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
    : '?';

  return (
    <div
      className="flex items-center gap-3 rounded-xl p-3"
      style={{ background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 8%, transparent)' }}
    >
      <div
        className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-white shrink-0 text-sm"
        style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
      >
        {initials}
      </div>
      <div className="min-w-0">
        <p className="font-semibold text-sm text-on-surface truncate">{ownerLabel ?? t('cases.noOwner')}</p>
        <p className="text-[10px] text-on-surface-variant uppercase tracking-wider font-medium">Owner</p>
      </div>
    </div>
  );
}

const entryVariants = {
  hidden: { opacity: 0, x: -12 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

function AuditTimeline({ entries }: { entries: CaseAuditEntry[] }) {
  const { t } = useTranslation();
  const sorted = [...entries].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  if (sorted.length === 0) {
    return <p className="text-sm text-on-surface-variant italic">{t('cases.detail.noAuditEntries')}</p>;
  }

  function getDotSize(entry: CaseAuditEntry): number {
    if (entry.action === 'status_change') return 20;
    if (entry.action === 'note_added') return 14;
    return 12;
  }

  return (
    <motion.div
      className="relative flex flex-col gap-0"
      variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.07 } } }}
      initial="hidden"
      animate="visible"
    >
      {/* Vertical connector line — gradient */}
      <div
        className="absolute left-[9px] top-5 bottom-5 w-[2px]"
        style={{ background: 'linear-gradient(to bottom, color-mix(in srgb, var(--color-primary) 15%, transparent), transparent)' }}
      />
      <AnimatePresence>
        {sorted.map((entry, i) => {
          const dotSize = getDotSize(entry);
          const dotOffset = Math.round((20 - dotSize) / 2);
          const toSt = entry.to_status ? STATUS_COLORS[entry.to_status as CaseStatus] : null;
          const dotColor = toSt?.text ?? '#6b7280';

          return (
            <motion.div
              key={i}
              variants={entryVariants}
              className="relative flex gap-4 pb-5 group"
            >
              {/* Dot */}
              <div
                className="shrink-0 z-10 rounded-full border-2 border-white"
                style={{
                  width: dotSize,
                  height: dotSize,
                  marginTop: dotOffset,
                  background: dotColor,
                  boxShadow: `0 0 0 3px ${dotColor}22`,
                }}
              />
              {/* Entry card */}
              <div
                className="flex-1 min-w-0 pt-0.5 rounded-xl px-3 py-2 transition-all duration-200"
                style={{
                  background: 'transparent',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.6)';
                  (e.currentTarget as HTMLDivElement).style.boxShadow = '0 2px 12px rgba(0,0,0,0.04)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                  (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
                }}
              >
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="text-xs font-bold text-on-surface">{entry.action}</span>
                  {entry.from_status && entry.to_status && (
                    <div className="flex items-center gap-1">
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          background: STATUS_COLORS[entry.from_status as CaseStatus]?.bg ?? '#f3f4f6',
                          color: STATUS_COLORS[entry.from_status as CaseStatus]?.text ?? '#6b7280',
                        }}
                      >
                        {entry.from_status}
                      </span>
                      <Icon name="arrow_forward" size={10} className="text-on-surface-variant" />
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          background: STATUS_COLORS[entry.to_status as CaseStatus]?.bg ?? '#f3f4f6',
                          color: STATUS_COLORS[entry.to_status as CaseStatus]?.text ?? '#6b7280',
                        }}
                      >
                        {entry.to_status}
                      </span>
                    </div>
                  )}
                </div>
                <p className="text-xs">
                  <span className="font-semibold text-on-surface">{entry.actor}</span>
                  <span className="text-on-surface-variant"> · {new Date(entry.ts).toLocaleString()}</span>
                </p>
                {entry.note && (
                  <div
                    className="mt-2 rounded-r-lg px-3 py-2"
                    style={{
                      borderLeft: '3px solid var(--color-primary)',
                      background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)',
                    }}
                  >
                    <p className="text-sm text-on-surface-variant italic leading-relaxed">{entry.note}</p>
                  </div>
                )}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </motion.div>
  );
}

export function CaseDetailPage() {
  const { t } = useTranslation();
  const { caseId } = useParams<{ caseId: string }>();
  const api = useApi();

  const [cxCase, setCxCase] = useState<CxCase | null>(null);
  const [loading, setLoading] = useState(true);

  const [note, setNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const [newOwner, setNewOwner] = useState('');
  const [savingOwner, setSavingOwner] = useState(false);

  const [changingStatus, setChangingStatus] = useState(false);

  useSetPageTitle(cxCase?.title ?? t('cases.detail.title'), t('cases.detail.subtitle'));

  const load = useCallback(async () => {
    if (!caseId) return;
    setLoading(true);
    try {
      const result = await api.getCase(caseId);
      setCxCase(result);
    } catch {
      setCxCase(null);
    } finally {
      setLoading(false);
    }
  }, [api, caseId]);

  useEffect(() => { load(); }, [load]);

  async function handleAddNote() {
    if (!caseId || !note.trim()) return;
    setSavingNote(true);
    try {
      const log = await api.addCaseEvent(caseId, { action: 'note_added', note: note.trim() });
      setCxCase((prev) => prev ? { ...prev, audit_log: log } : prev);
      setNote('');
      invalidate('cases');
    } finally {
      setSavingNote(false);
    }
  }

  async function handleStatusChange(status: string) {
    if (!caseId) return;
    setChangingStatus(true);
    try {
      const updated = await api.updateCase(caseId, { status: status as CaseStatus });
      setCxCase(updated);
      invalidate('cases');
    } finally {
      setChangingStatus(false);
    }
  }

  async function handleOwnerChange() {
    if (!caseId || !newOwner.trim()) return;
    setSavingOwner(true);
    try {
      const updated = await api.updateCase(caseId, { owner_label: newOwner.trim() });
      setCxCase(updated);
      setNewOwner('');
      invalidate('cases');
    } finally {
      setSavingOwner(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto w-full">
        <div className="h-10 skeleton rounded-xl w-1/3 mb-8" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-3">
              {[0, 1, 2].map((j) => <div key={j} className="skeleton h-20 rounded-2xl" />)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!cxCase) {
    return (
      <div className="max-w-7xl mx-auto w-full">
        <PageHeader
          crumbs={[{ label: t('cases.title'), path: ROUTES.CASES }, { label: t('cases.detail.title') }]}
          title={t('cases.detail.title')}
        />
        <p className="text-on-surface-variant">{t('cases.noCases')}</p>
      </div>
    );
  }

  const sev = SEVERITY_COLORS[cxCase.severity] ?? SEVERITY_COLORS.medium;
  const st  = STATUS_COLORS[cxCase.status]   ?? STATUS_COLORS.open;
  const transitions = STATUS_TRANSITIONS[cxCase.status] ?? [];

  const severityBorderMap: Record<CaseSeverity, string> = {
    critical: '#dc2626',
    high:     '#d97706',
    medium:   '#2a4bd9',
    low:      '#059669',
  };
  const sevBorderColor = severityBorderMap[cxCase.severity] ?? '#2a4bd9';

  return (
    <div className="max-w-7xl mx-auto w-full">
      {/* Holographic keyframe injection */}
      <style>{`
        @keyframes holographic {
          0%, 100% { transform: translateX(-100%); }
          50% { transform: translateX(200%); }
        }
      `}</style>

      <PageHeader
        crumbs={[
          { label: t('cases.title'), path: ROUTES.CASES },
          { label: cxCase.title },
        ]}
        title={cxCase.title}
        subtitle={t('cases.detail.subtitle')}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* ── Left: Case metadata ───────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-4"
        >
          {/* Metadata card with severity strip */}
          <div
            style={{
              ...glassmorphism,
              borderLeft: `4px solid ${sevBorderColor}`,
              padding: '1.25rem',
            }}
          >
            {/* Severity banner */}
            <div
              className="flex items-center gap-2 rounded-lg px-3 py-2 mb-4"
              style={{ background: sev.bg }}
            >
              <div className={`w-2 h-2 rounded-full ${sev.dotClass ?? ''}`} style={{ background: sev.border }} />
              <span className="text-xs font-bold uppercase tracking-wider" style={{ color: sev.text }}>
                {t(`cases.severity.${cxCase.severity}`)}
              </span>
              <span className="text-xs text-on-surface-variant ml-auto">{t('cases.detail.metadataCard')}</span>
            </div>

            {/* SLA Ring */}
            <div className="mb-4 pl-1">
              <SlaRing resolveDueAt={cxCase.resolve_due_at} breached={cxCase.sla_breached} />
            </div>

            {/* Status stepper */}
            <div className="mb-4">
              <p className="label-caps mb-3 text-on-surface-variant">Status</p>
              <StatusStepper status={cxCase.status} />
              {/* Current status badge */}
              <div className="mt-3 flex items-center gap-2">
                <span
                  className="font-bold px-2.5 py-1 rounded-full text-xs"
                  style={{ background: st.bg, color: st.text }}
                >
                  {t(`cases.status.${cxCase.status}`)}
                </span>
                <SlaTimerBadge resolveDueAt={cxCase.resolve_due_at} breached={cxCase.sla_breached} />
              </div>
            </div>

            {/* Divider */}
            <div className="my-4 h-px" style={{ background: 'rgba(0,0,0,0.06)' }} />

            {/* Owner card */}
            <div className="mb-4">
              <p className="label-caps mb-2 text-on-surface-variant">Owner</p>
              <OwnerCard ownerLabel={cxCase.owner_label} />
            </div>

            {/* Metadata rows */}
            {cxCase.driver_ref && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-on-surface-variant">{t('cases.driverRef')}</span>
                <span className="font-semibold text-on-surface">{cxCase.driver_ref}</span>
              </div>
            )}

            {/* External refs */}
            {Object.keys(cxCase.external_refs ?? {}).length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {cxCase.external_refs?.slack_ts && (
                  <span
                    className="text-[11px] font-semibold px-2.5 py-1.5 rounded-full flex items-center gap-1"
                    style={{
                      background: 'linear-gradient(135deg, rgba(74,21,75,0.06), rgba(74,21,75,0.12))',
                      border: '1px solid rgba(74,21,75,0.15)',
                      color: '#4a154b',
                    }}
                  >
                    <Icon name="chat" size={11} />
                    {t('cases.externalSlack')}
                  </span>
                )}
                {cxCase.external_refs?.jira_key && (
                  <span
                    className="text-[11px] font-semibold px-2.5 py-1.5 rounded-full flex items-center gap-1"
                    style={{
                      background: 'linear-gradient(135deg, rgba(0,82,204,0.06), rgba(0,82,204,0.12))',
                      border: '1px solid rgba(0,82,204,0.15)',
                      color: '#0052cc',
                    }}
                  >
                    <Icon name="bug_report" size={11} />
                    {cxCase.external_refs.jira_key}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Status transition card */}
          {transitions.length > 0 && (
            <div style={{ ...glassmorphism, padding: '1.25rem' }}>
              <p className="label-caps mb-3">
                <span style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
                  {t('cases.detail.statusTransition')}
                </span>
              </p>
              <Select onValueChange={handleStatusChange} disabled={changingStatus}>
                <SelectTrigger
                  className="w-full rounded-xl border-0 text-sm"
                  style={{
                    background: 'rgba(255,255,255,0.6)',
                    backdropFilter: 'blur(8px)',
                    border: '1px solid rgba(255,255,255,0.8)',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                  }}
                >
                  <SelectValue placeholder={t('cases.changeStatus')} />
                </SelectTrigger>
                <SelectContent>
                  {transitions.map((s) => (
                    <SelectItem key={s} value={s}>
                      <span style={{ color: STATUS_COLORS[s]?.text ?? '#6b7280' }}>
                        {t(`cases.status.${s}`)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Reassign owner card */}
          <div style={{ ...glassmorphism, padding: '1.25rem' }}>
            <p className="label-caps mb-3">{t('cases.detail.reassignOwner')}</p>
            <div className="flex gap-2">
              <Input
                value={newOwner}
                onChange={(e) => setNewOwner(e.target.value)}
                placeholder={t('cases.detail.ownerPlaceholder')}
                className="flex-1 rounded-xl border-0 text-sm"
                style={{
                  background: 'rgba(255,255,255,0.6)',
                  backdropFilter: 'blur(8px)',
                  border: '1px solid rgba(255,255,255,0.8)',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleOwnerChange()}
              />
              <Button
                size="sm"
                onClick={handleOwnerChange}
                disabled={!newOwner.trim() || savingOwner}
                className="rounded-xl font-bold text-white shrink-0"
                style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
              >
                <Icon name="check" size={15} />
              </Button>
            </div>
          </div>
        </motion.div>

        {/* ── Center: Audit timeline ─────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.06, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-4"
        >
          <div style={{ ...glassmorphism, padding: '1.25rem', flex: 1 }}>
            <p className="label-caps mb-5">{t('cases.detail.timeline')}</p>
            <AuditTimeline entries={cxCase.audit_log ?? []} />
          </div>

          {/* Add note — floating elegant card */}
          <div
            style={{
              ...glassmorphism,
              padding: '1.25rem',
              boxShadow: '0 8px 32px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.8)',
            }}
          >
            <p className="label-caps mb-3">{t('cases.addNote')}</p>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('cases.notePlaceholder')}
              className="w-full min-h-[80px] rounded-xl border-0 text-sm resize-y mb-3"
              style={{
                background: 'rgba(255,255,255,0.6)',
                backdropFilter: 'blur(8px)',
                border: '1px solid rgba(255,255,255,0.8)',
                boxShadow: 'inset 0 1px 4px rgba(0,0,0,0.04)',
              }}
            />
            <Button
              onClick={handleAddNote}
              disabled={!note.trim() || savingNote}
              size="sm"
              className="w-full rounded-xl font-bold text-white"
              style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
            >
              {savingNote ? (
                <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin border-white" />
              ) : (
                <>
                  <Icon name="add_comment" size={14} className="mr-1.5" />
                  {t('cases.detail.addNoteButton')}
                </>
              )}
            </Button>
          </div>
        </motion.div>

        {/* ── Right: Crystal context ─────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-4"
        >
          {/* Linked contact */}
          {cxCase.contact && (
            <div style={{ ...glassmorphism, padding: '1.25rem' }}>
              <p className="label-caps mb-3">{t('cases.linkedContact')}</p>
              <div className="flex items-center gap-3 mb-3">
                <div
                  className="w-11 h-11 rounded-full flex items-center justify-center font-bold text-white shrink-0"
                  style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
                >
                  {cxCase.contact.name ? cxCase.contact.name.charAt(0).toUpperCase() : '?'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-on-surface truncate">{cxCase.contact.name ?? '****'}</p>
                  <p className="text-xs text-on-surface-variant truncate flex items-center gap-1">
                    {cxCase.contact.email ? (
                      cxCase.contact.email
                    ) : (
                      <>
                        <Icon name="lock" size={10} />
                        <span>Protected</span>
                      </>
                    )}
                  </p>
                </div>
              </div>
              {cxCase.contact_id && (
                <Link
                  to={toPath(ROUTES.CONTACT_DETAIL, { contactId: cxCase.contact_id })}
                  className="mt-1 text-xs font-semibold block"
                  style={{
                    background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                  }}
                >
                  {t('contacts.viewContact')} →
                </Link>
              )}
            </div>
          )}

          {/* Crystal suggested actions — holographic shimmer */}
          <div
            style={{
              background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 6%, transparent) 0%, color-mix(in srgb, var(--color-tertiary) 8%, transparent) 50%, color-mix(in srgb, var(--color-secondary) 5%, transparent) 100%)',
              border: '1px solid color-mix(in srgb, var(--color-tertiary) 20%, transparent)',
              borderRadius: '1rem',
              padding: '1.25rem',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {/* Holographic shimmer overlay */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '1rem',
                background: 'linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.08) 50%, transparent 60%)',
                animation: 'holographic 3s ease-in-out infinite',
              }}
            />
            <div style={{ position: 'relative', zIndex: 1 }}>
              <div className="flex items-center gap-2 mb-3">
                <span
                  className="material-symbols-outlined text-[18px]"
                  style={{
                    background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                  }}
                >
                  auto_awesome
                </span>
                <p className="label-caps" style={{ color: 'var(--color-primary)' }}>{t('cases.detail.suggestedActions')}</p>
              </div>
              <p className="text-sm text-on-surface-variant leading-relaxed">
                {t('cases.detail.suggestedActionsBody')}
              </p>
            </div>
          </div>

          {/* Case description */}
          {cxCase.description && (
            <div
              style={{
                ...glassmorphism,
                padding: '1.25rem',
                borderLeft: '3px solid var(--color-primary)',
              }}
            >
              <p className="label-caps mb-2">{t('cases.detail.metadataCard')}</p>
              <p className="text-sm text-on-surface-variant leading-relaxed italic pl-1">{cxCase.description}</p>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}
