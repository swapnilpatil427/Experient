import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useApi } from '../hooks/useApi';
import { useTranslation } from '../lib/i18n';
import { ROUTES } from '../constants/routes';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { OwnershipRoute } from '../types';

type Dimension = OwnershipRoute['dimension'];
type MatchType  = OwnershipRoute['match_type'];

const DIMENSIONS: Dimension[] = ['segment', 'account', 'touchpoint', 'driver', 'survey', 'category'];

const DIMENSION_COLORS: Record<string, string> = {
  segment: '#2a4bd9',
  account: '#00647c',
  touchpoint: '#8329c8',
  driver: '#d97706',
  survey: '#059669',
  category: '#dc2626',
};

const MATCH_TYPE_STYLES: Record<MatchType, { background: string; color: string }> = {
  exact:    { background: 'rgba(5,150,105,0.1)',   color: '#059669' },
  prefix:   { background: 'rgba(42,75,217,0.1)',   color: '#2a4bd9' },
  contains: { background: 'rgba(217,119,6,0.1)',   color: '#d97706' },
  regex:    { background: 'rgba(131,41,200,0.1)',  color: '#8329c8' },
};

const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.04 } } };
const rise = {
  hidden:  { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

interface RuleFormState {
  match_value: string;
  match_type: MatchType;
  owner_user_id: string;
  owner_label: string;
  escalation_user_id: string;
  escalation_label: string;
  priority: string;
  role_label: string;
}

const DEFAULT_FORM: RuleFormState = {
  match_value: '',
  match_type: 'exact',
  owner_user_id: '',
  owner_label: '',
  escalation_user_id: '',
  escalation_label: '',
  priority: '100',
  role_label: '',
};

export function OwnershipRoutingPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('ownership.title'), t('ownership.subtitle'));
  const api = useApi();

  const [activeDimension, setActiveDimension] = useState<Dimension>('segment');
  const [routes, setRoutes] = useState<OwnershipRoute[]>([]);
  const [loading, setLoading] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [formState, setFormState] = useState<RuleFormState>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);

  const [testValue, setTestValue] = useState('');
  const [testResult, setTestResult] = useState<{ matched: boolean; route: OwnershipRoute | null } | null>(null);
  const [testing, setTesting] = useState(false);

  const loadRoutes = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listOwnershipRoutes(activeDimension);
      setRoutes(list);
    } catch {
      setRoutes([]);
    } finally {
      setLoading(false);
    }
  }, [api, activeDimension]);

  useEffect(() => { loadRoutes(); }, [loadRoutes]);

  function updateForm(key: keyof RuleFormState, value: string) {
    setFormState((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSaveRule() {
    if (!formState.match_value || !formState.owner_user_id) return;
    setSaving(true);
    try {
      await api.createOwnershipRoute({
        dimension:           activeDimension,
        match_value:         formState.match_value,
        match_type:          formState.match_type,
        owner_user_id:       formState.owner_user_id,
        owner_label:         formState.owner_label || undefined,
        escalation_user_id:  formState.escalation_user_id || undefined,
        escalation_label:    formState.escalation_label || undefined,
        priority:            Number(formState.priority) || 100,
        role_label:          formState.role_label || undefined,
      });
      setShowForm(false);
      setFormState(DEFAULT_FORM);
      loadRoutes();
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteRoute(id: string) {
    await api.deleteOwnershipRoute(id);
    loadRoutes();
  }

  async function handleTestRoute() {
    if (!testValue.trim()) return;
    setTesting(true);
    try {
      const result = await api.resolveOwnershipRoute(activeDimension, testValue.trim());
      setTestResult(result);
    } catch {
      setTestResult(null);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: t('nav.settings'), path: ROUTES.SETTINGS },
          { label: t('ownership.title') },
        ]}
        title={t('ownership.title')}
        subtitle={t('ownership.subtitle')}
        actions={
          <Button
            onClick={() => { setShowForm(true); setFormState(DEFAULT_FORM); }}
            className="font-bold text-sm text-white rounded-xl px-5 py-2.5"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
          >
            <Icon name="add" size={16} className="mr-1.5" />
            {t('ownership.addRule')}
          </Button>
        }
      />

      {/* Intro text */}
      <p className="text-sm text-on-surface-variant mb-6 max-w-2xl">{t('ownership.intro')}</p>

      {/* Dimension tabs — pill-shaped with gradient active state */}
      <div className="flex flex-wrap gap-2 mb-6">
        {DIMENSIONS.map((dim) => (
          <button
            key={dim}
            onClick={() => { setActiveDimension(dim); setShowForm(false); setTestResult(null); }}
            className="px-4 py-2 rounded-full text-sm font-semibold transition-all duration-200"
            style={activeDimension === dim ? {
              background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
              color: 'white',
              boxShadow: '0 4px 14px color-mix(in srgb, var(--color-primary) 35%, transparent)',
              transform: 'translateY(-1px)',
            } : {
              background: 'rgba(255,255,255,0.7)',
              border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)',
              color: 'var(--color-on-surface-variant)',
              backdropFilter: 'blur(8px)',
            }}
          >
            {t(`ownership.dimensions.${dim}`)}
          </button>
        ))}
      </div>

      {/* Add Rule form — glassmorphism panel */}
      {showForm && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="mb-6"
        >
          <div style={{
            background: 'rgba(255,255,255,0.85)',
            backdropFilter: 'blur(20px)',
            border: '1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)',
            borderRadius: '1.25rem',
            padding: '1.5rem',
            boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
          }}>
            <p className="label-caps mb-4" style={{
              background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
              fontSize: '0.625rem',
              fontWeight: 900,
              letterSpacing: '0.15em',
              textTransform: 'uppercase',
            }}>
              {t('ownership.addRule')} — {t(`ownership.dimensions.${activeDimension}`)}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label className="text-xs font-bold uppercase tracking-widest mb-2 block text-on-surface-variant">{t('ownership.form.matchValue')}</Label>
                <Input
                  value={formState.match_value}
                  onChange={(e) => updateForm('match_value', e.target.value)}
                  placeholder={t('ownership.form.matchValuePlaceholder')}
                  style={{
                    background: 'rgba(255,255,255,0.7)',
                    border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)',
                    borderRadius: '0.75rem',
                  }}
                />
              </div>
              <div>
                <Label className="text-xs font-bold uppercase tracking-widest mb-2 block text-on-surface-variant">{t('ownership.form.matchType')}</Label>
                <Select value={formState.match_type} onValueChange={(v) => updateForm('match_type', v)}>
                  <SelectTrigger style={{
                    background: 'rgba(255,255,255,0.7)',
                    border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)',
                    borderRadius: '0.75rem',
                  }}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['exact', 'prefix', 'contains', 'regex'] as MatchType[]).map((mt) => (
                      <SelectItem key={mt} value={mt}>{t(`ownership.matchTypes.${mt}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs font-bold uppercase tracking-widest mb-2 block text-on-surface-variant">{t('ownership.form.ownerUserId')}</Label>
                <Input
                  value={formState.owner_user_id}
                  onChange={(e) => updateForm('owner_user_id', e.target.value)}
                  placeholder={t('ownership.form.ownerUserIdPlaceholder')}
                  className="font-mono text-sm"
                  style={{
                    background: 'rgba(255,255,255,0.7)',
                    border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)',
                    borderRadius: '0.75rem',
                  }}
                />
              </div>
              <div>
                <Label className="text-xs font-bold uppercase tracking-widest mb-2 block text-on-surface-variant">{t('ownership.form.ownerLabel')}</Label>
                <Input
                  value={formState.owner_label}
                  onChange={(e) => updateForm('owner_label', e.target.value)}
                  placeholder={t('ownership.form.ownerLabelPlaceholder')}
                  style={{
                    background: 'rgba(255,255,255,0.7)',
                    border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)',
                    borderRadius: '0.75rem',
                  }}
                />
              </div>
              <div>
                <Label className="text-xs font-bold uppercase tracking-widest mb-2 block text-on-surface-variant">{t('ownership.form.escalationUserId')}</Label>
                <Input
                  value={formState.escalation_user_id}
                  onChange={(e) => updateForm('escalation_user_id', e.target.value)}
                  placeholder={t('ownership.form.ownerUserIdPlaceholder')}
                  className="font-mono text-sm"
                  style={{
                    background: 'rgba(255,255,255,0.7)',
                    border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)',
                    borderRadius: '0.75rem',
                  }}
                />
              </div>
              <div>
                <Label className="text-xs font-bold uppercase tracking-widest mb-2 block text-on-surface-variant">{t('ownership.form.escalationLabel')}</Label>
                <Input
                  value={formState.escalation_label}
                  onChange={(e) => updateForm('escalation_label', e.target.value)}
                  placeholder={t('ownership.form.ownerLabelPlaceholder')}
                  style={{
                    background: 'rgba(255,255,255,0.7)',
                    border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)',
                    borderRadius: '0.75rem',
                  }}
                />
              </div>
              <div>
                <Label className="text-xs font-bold uppercase tracking-widest mb-2 block text-on-surface-variant">{t('ownership.form.priority')}</Label>
                <Input
                  type="number"
                  value={formState.priority}
                  onChange={(e) => updateForm('priority', e.target.value)}
                  className="w-28"
                  style={{
                    background: 'rgba(255,255,255,0.7)',
                    border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)',
                    borderRadius: '0.75rem',
                  }}
                />
              </div>
              <div>
                <Label className="text-xs font-bold uppercase tracking-widest mb-2 block text-on-surface-variant">{t('ownership.form.roleLabel')}</Label>
                <Input
                  value={formState.role_label}
                  onChange={(e) => updateForm('role_label', e.target.value)}
                  placeholder={t('ownership.form.roleLabelPlaceholder')}
                  style={{
                    background: 'rgba(255,255,255,0.7)',
                    border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)',
                    borderRadius: '0.75rem',
                  }}
                />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <Button variant="secondary" onClick={() => setShowForm(false)} className="rounded-xl font-bold">{t('ownership.cancelRule')}</Button>
              <Button
                onClick={handleSaveRule}
                disabled={!formState.match_value || !formState.owner_user_id || saving}
                className="rounded-xl font-bold text-white"
                style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
              >
                {saving ? <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin border-white" /> : t('ownership.saveRule')}
              </Button>
            </div>
          </div>
        </motion.div>
      )}

      {/* Rules table */}
      {loading ? (
        <div className="flex items-center justify-center py-10">
          <div className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'var(--color-primary)', borderTopColor: 'transparent' }} />
        </div>
      ) : routes.length > 0 ? (
        <motion.div variants={stagger} initial="hidden" animate="visible" className="mb-8">
          {/* Dimension color indicator */}
          <div className="flex items-center gap-2 mb-3">
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.375rem',
              background: `${DIMENSION_COLORS[activeDimension]}14`,
              color: DIMENSION_COLORS[activeDimension],
              border: `1px solid ${DIMENSION_COLORS[activeDimension]}30`,
              borderRadius: '9999px',
              padding: '0.2rem 0.75rem',
              fontSize: '0.7rem',
              fontWeight: 800,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: DIMENSION_COLORS[activeDimension],
                display: 'inline-block',
              }} />
              {t(`ownership.dimensions.${activeDimension}`)}
            </span>
            <span className="text-xs text-on-surface-variant">{routes.length} {routes.length === 1 ? 'rule' : 'rules'}</span>
          </div>

          <div className="overflow-x-auto" style={{
            background: 'rgba(255,255,255,0.72)',
            backdropFilter: 'blur(32px)',
            border: '1px solid rgba(255,255,255,0.6)',
            borderRadius: '1rem',
            boxShadow: '0 4px 24px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.8)',
          }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid color-mix(in srgb, var(--color-primary) 8%, transparent)' }}>
                  {(['columns.matchValue', 'columns.matchType', 'columns.owner', 'columns.escalation', 'columns.priority', 'columns.actions'] as const).map((key) => (
                    <th
                      key={key}
                      className="text-left px-5 py-3"
                      style={{
                        fontSize: '0.625rem',
                        fontWeight: 800,
                        letterSpacing: '0.12em',
                        textTransform: 'uppercase',
                        color: 'var(--color-primary)',
                        opacity: 0.7,
                      }}
                    >
                      {t(`ownership.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {routes.map((route) => {
                  const ownerDisplay = route.owner_label ?? route.owner_user_id;
                  const ownerInitials = ownerDisplay.split(' ').map((w: string) => w[0]).slice(0, 2).join('').toUpperCase();
                  const escalationDisplay = route.escalation_label ?? (route.escalation_user_id || null);
                  const escalationInitials = escalationDisplay
                    ? escalationDisplay.split(' ').map((w: string) => w[0]).slice(0, 2).join('').toUpperCase()
                    : null;
                  const matchTypeStyle = MATCH_TYPE_STYLES[route.match_type] ?? MATCH_TYPE_STYLES.exact;

                  return (
                    <motion.tr
                      key={route.id}
                      variants={rise}
                      className="transition-colors"
                      style={{ borderBottom: '1px solid color-mix(in srgb, var(--color-primary) 5%, transparent)' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = 'color-mix(in srgb, var(--color-primary) 3%, transparent)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'; }}
                    >
                      {/* Match Value — code chip */}
                      <td className="px-5 py-3">
                        <span style={{
                          background: 'color-mix(in srgb, var(--color-primary) 6%, transparent)',
                          color: 'var(--color-primary)',
                          fontFamily: 'monospace',
                          borderRadius: '0.5rem',
                          padding: '0.25rem 0.5rem',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                        }}>
                          {route.match_value}
                        </span>
                      </td>

                      {/* Match Type — color-coded badge */}
                      <td className="px-5 py-3">
                        <span style={{
                          ...matchTypeStyle,
                          fontSize: '0.625rem',
                          fontWeight: 800,
                          letterSpacing: '0.08em',
                          textTransform: 'uppercase',
                          padding: '0.2rem 0.6rem',
                          borderRadius: '9999px',
                          display: 'inline-block',
                        }}>
                          {t(`ownership.matchTypes.${route.match_type}`)}
                        </span>
                      </td>

                      {/* Owner — avatar + label + role */}
                      <td className="px-5 py-3">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <div style={{
                            width: 28, height: 28, borderRadius: '50%',
                            background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
                            color: 'white', fontSize: 10, fontWeight: 700,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                          }}>
                            {ownerInitials}
                          </div>
                          <div>
                            <div className="font-semibold text-on-surface text-sm">{ownerDisplay}</div>
                            {route.role_label && (
                              <div style={{ fontSize: '0.7rem', color: 'var(--color-on-surface-variant)', opacity: 0.75 }}>
                                {route.role_label}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Escalation — avatar chip or dash */}
                      <td className="px-5 py-3">
                        {escalationDisplay && escalationInitials ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <div style={{
                              width: 24, height: 24, borderRadius: '50%',
                              background: 'linear-gradient(135deg, var(--color-secondary), #059669)',
                              color: 'white', fontSize: 9, fontWeight: 700,
                              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                            }}>
                              {escalationInitials}
                            </div>
                            <span className="text-sm text-on-surface-variant">{escalationDisplay}</span>
                          </div>
                        ) : (
                          <span style={{ color: 'var(--color-on-surface-variant)', opacity: 0.4, fontWeight: 600 }}>—</span>
                        )}
                      </td>

                      {/* Priority — monospace code badge */}
                      <td className="px-5 py-3">
                        <span style={{
                          background: 'rgba(0,0,0,0.04)',
                          fontFamily: 'monospace',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          padding: '0.2rem 0.5rem',
                          borderRadius: '0.4rem',
                          color: 'var(--color-on-surface)',
                          minWidth: '2.5rem',
                          display: 'inline-block',
                          textAlign: 'right',
                        }}>
                          {String(route.priority).padStart(3, ' ')}
                        </span>
                      </td>

                      {/* Actions — ghost delete button */}
                      <td className="px-5 py-3">
                        <button
                          onClick={() => handleDeleteRoute(route.id)}
                          style={{
                            color: '#dc2626',
                            background: 'transparent',
                            border: 'none',
                            borderRadius: '0.5rem',
                            padding: '0.375rem',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(220,38,38,0.08)'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                        >
                          <Icon name="delete" size={15} />
                        </button>
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </motion.div>
      ) : (
        /* Empty state — large centered illustration */
        <div className="text-center py-16 mb-8">
          <div style={{
            width: 80, height: 80, borderRadius: '1.25rem', margin: '0 auto 1rem',
            background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 10%, transparent), color-mix(in srgb, var(--color-tertiary) 10%, transparent))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon name="route" size={36} style={{ color: 'var(--color-primary)' }} />
          </div>
          <h3 style={{
            fontSize: '1.125rem', fontWeight: 800, marginBottom: '0.5rem',
            background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
          }}>
            {t('ownership.empty', { dimension: t(`ownership.dimensions.${activeDimension}`) })}
          </h3>
          <Button
            onClick={() => { setShowForm(true); setFormState(DEFAULT_FORM); }}
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))', color: 'white', borderRadius: '0.75rem', marginTop: '1rem' }}
            className="font-bold px-6 py-2.5"
          >
            <Icon name="add" size={16} className="mr-1.5" />
            {t('ownership.addRule')}
          </Button>
        </div>
      )}

      {/* Test Route section — sleek glassmorphism card */}
      <Card style={{
        background: 'rgba(255,255,255,0.72)',
        backdropFilter: 'blur(32px) saturate(180%)',
        border: '1px solid rgba(255,255,255,0.6)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.8)',
        borderRadius: '1rem',
        padding: '1.5rem',
      }}>
        {/* Header with gradient label */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
          <span style={{
            background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            fontSize: '0.625rem',
            fontWeight: 900,
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
          }}>
            {t('ownership.testRoute')}
          </span>
        </div>
        <p className="text-sm text-on-surface-variant mb-4">
          Testing dimension: <strong style={{ color: DIMENSION_COLORS[activeDimension] }}>{t(`ownership.dimensions.${activeDimension}`)}</strong>
        </p>
        <div className="flex gap-3">
          <Input
            value={testValue}
            onChange={(e) => setTestValue(e.target.value)}
            placeholder={t('ownership.testPlaceholder')}
            className="flex-1"
            style={{
              background: 'rgba(255,255,255,0.7)',
              border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)',
              borderRadius: '0.75rem',
            }}
            onKeyDown={(e) => e.key === 'Enter' && handleTestRoute()}
          />
          <Button
            onClick={handleTestRoute}
            disabled={!testValue.trim() || testing}
            className="rounded-xl font-bold text-white px-5"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
          >
            {testing ? <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin border-white" /> : t('ownership.testButton')}
          </Button>
        </div>

        {/* Test result card */}
        {testResult !== null && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 p-4 rounded-xl"
            style={testResult.matched ? {
              background: 'rgba(5,150,105,0.06)',
              border: '1px solid rgba(5,150,105,0.2)',
            } : {
              background: 'rgba(107,114,128,0.06)',
              border: '1px solid rgba(107,114,128,0.15)',
            }}
          >
            {testResult.matched && testResult.route ? (
              <div style={{ display: 'flex', gap: '0.625rem', alignItems: 'flex-start' }}>
                <div style={{
                  width: 20, height: 20, borderRadius: '50%',
                  background: 'rgba(5,150,105,0.15)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1,
                }}>
                  <Icon name="check" size={12} style={{ color: '#059669' }} />
                </div>
                <div>
                  <p style={{ fontSize: '0.875rem', fontWeight: 700, color: '#059669', marginBottom: '0.25rem' }}>
                    {t('ownership.matchedOwner', { owner: testResult.route.owner_label ?? testResult.route.owner_user_id })}
                  </p>
                  <p className="text-xs text-on-surface-variant">
                    Rule: <span className="font-mono">{testResult.route.match_value}</span> ({t(`ownership.matchTypes.${testResult.route.match_type}`)})
                    {testResult.route.role_label && ` · ${testResult.route.role_label}`}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-on-surface-variant">{t('ownership.noMatch')}</p>
            )}
          </motion.div>
        )}
      </Card>
    </div>
  );
}
