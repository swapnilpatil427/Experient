import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { ContactSegment, FilterDef, FilterCondition } from '../types';

const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.06 } } };
const rise = {
  hidden:  { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

const glassCard: React.CSSProperties = {
  background: 'rgba(255,255,255,0.72)',
  backdropFilter: 'blur(32px) saturate(180%)',
  border: '1px solid rgba(255,255,255,0.6)',
  boxShadow: '0 4px 24px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.8)',
  borderRadius: '1rem',
};

const gradientTextStyle: React.CSSProperties = {
  background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  backgroundClip: 'text',
};

const PRESET_COLORS = ['#2a4bd9', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];

const FILTER_FIELDS = [
  { value: 'account_name',  labelKey: 'contactSegments.filter.fields.account_name' },
  { value: 'account_id',    labelKey: 'contactSegments.filter.fields.account_id' },
  { value: 'consent_given', labelKey: 'contactSegments.filter.fields.consent_given' },
  { value: 'data_region',   labelKey: 'contactSegments.filter.fields.data_region' },
  { value: 'email_domain',  labelKey: 'contactSegments.filter.fields.email_domain' },
  { value: 'created_at',    labelKey: 'contactSegments.filter.fields.created_at' },
  { value: 'segment_attrs', labelKey: 'contactSegments.filter.fields.segment_attrs' },
];

const FILTER_OPERATORS = [
  { value: 'eq',          labelKey: 'contactSegments.filter.operators.eq' },
  { value: 'neq',         labelKey: 'contactSegments.filter.operators.neq' },
  { value: 'contains',    labelKey: 'contactSegments.filter.operators.contains' },
  { value: 'starts_with', labelKey: 'contactSegments.filter.operators.starts_with' },
  { value: 'ends_with',   labelKey: 'contactSegments.filter.operators.ends_with' },
  { value: 'in',          labelKey: 'contactSegments.filter.operators.in' },
  { value: 'before',      labelKey: 'contactSegments.filter.operators.before' },
  { value: 'after',       labelKey: 'contactSegments.filter.operators.after' },
  { value: 'within_days', labelKey: 'contactSegments.filter.operators.within_days' },
];

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface SegmentBuilderProps {
  open: boolean;
  segment?: ContactSegment | null;
  onClose: () => void;
  onSaved: () => void;
}

function SegmentBuilder({ open, segment, onClose, onSaved }: SegmentBuilderProps) {
  const { t } = useTranslation();
  const api = useApi();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [isDynamic, setIsDynamic] = useState(true);
  const [logic, setLogic] = useState<'AND' | 'OR'>('AND');
  const [conditions, setConditions] = useState<FilterCondition[]>([]);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (segment) {
      setName(segment.name);
      setDescription(segment.description ?? '');
      setColor(segment.color);
      setIsDynamic(segment.is_dynamic);
      setLogic(segment.filter_def.logic);
      setConditions(segment.filter_def.conditions);
    } else {
      setName('');
      setDescription('');
      setColor(PRESET_COLORS[0]);
      setIsDynamic(true);
      setLogic('AND');
      setConditions([]);
    }
    setPreviewCount(null);
  }, [segment, open]);

  useEffect(() => {
    if (conditions.length === 0) { setPreviewCount(null); return; }
    const filterDef: FilterDef = { logic, conditions };
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setPreviewLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await api.previewSegment(filterDef);
        setPreviewCount(result.count);
      } catch {
        setPreviewCount(null);
      } finally {
        setPreviewLoading(false);
      }
    }, 500);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [conditions, logic, api]);

  function addCondition() {
    setConditions((prev) => [...prev, { field: 'account_name', operator: 'contains', value: '' }]);
  }

  function removeCondition(idx: number) {
    setConditions((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateCondition(idx: number, patch: Partial<FilterCondition>) {
    setConditions((prev) => prev.map((c, i) => i === idx ? { ...c, ...patch } : c));
  }

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const payload: Partial<ContactSegment> = {
        name: name.trim(),
        description: description.trim() || undefined,
        color,
        is_dynamic: isDynamic,
        filter_def: { logic, conditions },
      };
      if (segment) {
        await api.updateSegment(segment.id, payload);
      } else {
        await api.createSegment(payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      console.error('[SegmentBuilder] save error', err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg overflow-y-auto"
        style={{
          background: 'rgba(255,255,255,0.96)',
          backdropFilter: 'blur(32px)',
        }}
      >
        <SheetHeader className="mb-6">
          <SheetTitle className="text-xl font-black font-headline" style={gradientTextStyle}>
            {segment ? t('contactSegments.editSegment') : t('contactSegments.newSegment')}
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">
              {t('contactSegments.form.name')}
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('contactSegments.form.namePlaceholder')}
              className="rounded-xl"
              style={{ background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">
              {t('contactSegments.form.description')}
            </Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('contactSegments.form.descriptionPlaceholder')}
              className="rounded-xl resize-none"
              style={{ background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }}
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">
              {t('contactSegments.form.color')}
            </Label>
            <div className="flex gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className="w-7 h-7 rounded-full transition-transform active:scale-90"
                  style={{
                    background: c,
                    outline: color === c ? `3px solid ${c}` : 'none',
                    outlineOffset: '2px',
                  }}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-semibold text-on-surface">{t('contactSegments.form.isDynamic')}</p>
              <p className="text-xs text-on-surface-variant">{t('contactSegments.form.isDynamicHint')}</p>
            </div>
            <Switch checked={isDynamic} onCheckedChange={setIsDynamic} />
          </div>

          <div
            className="rounded-xl p-4 space-y-3"
            style={{ background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)' }}
          >
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">
                {t('contactSegments.filter.heading')}
              </p>
              {conditions.length > 1 && (
                <div className="flex rounded-lg overflow-hidden border" style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)' }}>
                  {(['AND', 'OR'] as const).map((opt) => (
                    <button
                      key={opt}
                      onClick={() => setLogic(opt)}
                      className="text-xs font-bold px-3 py-1 transition-colors"
                      style={{
                        background: logic === opt ? 'var(--color-primary)' : 'transparent',
                        color: logic === opt ? '#fff' : 'var(--color-primary)',
                      }}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {conditions.map((cond, idx) => (
              <div key={idx} className="flex gap-2 items-center">
                <Select value={cond.field} onValueChange={(v) => updateCondition(idx, { field: v })}>
                  <SelectTrigger className="flex-1 text-xs rounded-lg h-8" style={{ background: 'rgba(255,255,255,0.8)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FILTER_FIELDS.map((f) => (
                      <SelectItem key={f.value} value={f.value}>{t(f.labelKey)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={cond.operator} onValueChange={(v) => updateCondition(idx, { operator: v as FilterCondition['operator'] })}>
                  <SelectTrigger className="flex-1 text-xs rounded-lg h-8" style={{ background: 'rgba(255,255,255,0.8)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FILTER_OPERATORS.map((op) => (
                      <SelectItem key={op.value} value={op.value}>{t(op.labelKey)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Input
                  value={cond.value}
                  onChange={(e) => updateCondition(idx, { value: e.target.value })}
                  placeholder={t('contactSegments.filter.value')}
                  className="flex-1 text-xs rounded-lg h-8"
                  style={{ background: 'rgba(255,255,255,0.8)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }}
                />

                <button
                  onClick={() => removeCondition(idx)}
                  className="text-on-surface-variant hover:text-red-500 transition-colors shrink-0"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            ))}

            <Button
              variant="ghost"
              size="sm"
              onClick={addCondition}
              className="text-xs w-full rounded-lg"
              style={{ border: '1px dashed color-mix(in srgb, var(--color-primary) 30%, transparent)', color: 'var(--color-primary)' }}
            >
              <Icon name="add" size={14} className="mr-1" />
              {t('contactSegments.filter.addCondition')}
            </Button>

            {conditions.length > 0 && (
              <p className="text-xs text-center font-medium" style={{ color: 'var(--color-primary)' }}>
                {previewLoading
                  ? t('contactSegments.filter.previewLoading')
                  : previewCount !== null
                    ? t('contactSegments.filter.preview', { count: String(previewCount) })
                    : null}
              </p>
            )}
          </div>

          <div className="flex gap-3 pt-2">
            <Button variant="secondary" className="flex-1 rounded-xl" onClick={onClose}>
              {t('contactSegments.form.cancel')}
            </Button>
            <Button
              disabled={!name.trim() || saving}
              onClick={handleSave}
              className="flex-1 rounded-xl font-bold text-white flex items-center justify-center gap-2"
              style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
            >
              {saving ? (
                <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin border-white" />
              ) : (
                t('contactSegments.form.save')
              )}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

interface SegmentCardProps {
  segment: ContactSegment;
  onEdit: (seg: ContactSegment) => void;
  onDelete: (seg: ContactSegment) => void;
  onRefresh: (seg: ContactSegment) => Promise<void>;
}

function SegmentCard({ segment, onEdit, onDelete, onRefresh }: SegmentCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await onRefresh(segment);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <motion.div variants={rise}>
      <Card
        style={{
          ...glassCard,
          borderLeft: `4px solid ${segment.color}`,
          overflow: 'hidden',
        }}
      >
        <div className="p-5">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-on-surface text-sm">{segment.name}</span>
                <Badge
                  className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                  style={{
                    background: segment.is_dynamic ? 'rgba(5,150,105,0.1)' : 'rgba(100,116,139,0.1)',
                    color: segment.is_dynamic ? '#059669' : '#475569',
                  }}
                >
                  {segment.is_dynamic ? t('contactSegments.dynamic') : t('contactSegments.static')}
                </Badge>
                <Badge
                  className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                  style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)', color: 'var(--color-primary)' }}
                >
                  {t('contactSegments.contactCount', { count: String(segment.contact_count) })}
                </Badge>
              </div>
              {segment.description && (
                <p className="text-xs text-on-surface-variant mt-1 truncate">{segment.description}</p>
              )}
              <p className="text-[10px] text-on-surface-variant mt-1.5">
                {segment.last_evaluated_at
                  ? t('contactSegments.lastRefreshed', { time: formatRelativeTime(segment.last_evaluated_at) })
                  : t('contactSegments.neverRefreshed')}
              </p>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                size="sm"
                variant="outline"
                className="text-xs rounded-lg h-7 px-2"
                onClick={() => navigate(ROUTES.CONTACTS)}
              >
                <Icon name="group" size={12} className="mr-1" />
                {t('contactSegments.viewMembers')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-xs rounded-lg h-7 px-2"
                onClick={handleRefresh}
                disabled={refreshing}
              >
                {refreshing ? (
                  <div className="w-3 h-3 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 30%, transparent)', borderTopColor: 'var(--color-primary)' }} />
                ) : (
                  <Icon name="refresh" size={12} />
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-xs rounded-lg h-7 w-7 p-0"
                onClick={() => onEdit(segment)}
              >
                <Icon name="edit" size={12} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-xs rounded-lg h-7 w-7 p-0 text-red-500 hover:text-red-600"
                onClick={() => onDelete(segment)}
              >
                <Icon name="delete" size={12} />
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </motion.div>
  );
}

export function ContactSegmentsPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('contactSegments.title'), t('contactSegments.subtitle'));
  const api = useApi();

  const [segments, setSegments] = useState<ContactSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingSegment, setEditingSegment] = useState<ContactSegment | null>(null);
  const [deletingSegment, setDeletingSegment] = useState<ContactSegment | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listSegments();
      setSegments(list);
    } catch (err) {
      console.error('[ContactSegmentsPage] load error', err);
      setSegments([]);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  function handleEdit(seg: ContactSegment) {
    setEditingSegment(seg);
    setBuilderOpen(true);
  }

  function handleNew() {
    setEditingSegment(null);
    setBuilderOpen(true);
  }

  async function handleRefresh(seg: ContactSegment) {
    try {
      const result = await api.refreshSegment(seg.id);
      setSegments((prev) => prev.map((s) => s.id === seg.id ? { ...s, contact_count: result.contact_count, last_evaluated_at: new Date().toISOString() } : s));
    } catch (err) {
      console.error('[ContactSegmentsPage] refresh error', err);
    }
  }

  async function handleDeleteConfirm() {
    if (!deletingSegment) return;
    setDeleting(true);
    try {
      await api.deleteSegment(deletingSegment.id);
      setSegments((prev) => prev.filter((s) => s.id !== deletingSegment.id));
      setDeletingSegment(null);
    } catch (err) {
      console.error('[ContactSegmentsPage] delete error', err);
    } finally {
      setDeleting(false);
    }
  }

  const dynamicCount = segments.filter((s) => s.is_dynamic).length;
  const totalContacts = segments.reduce((sum, s) => sum + s.contact_count, 0);

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: t('contacts.title'), path: ROUTES.CONTACTS },
          { label: t('contactSegments.title') },
        ]}
        title={t('contactSegments.title')}
        subtitle={t('contactSegments.subtitle')}
        actions={
          <Button
            onClick={handleNew}
            className="font-bold text-sm text-white rounded-xl px-5 py-2.5 active:scale-95"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
          >
            <Icon name="add" size={16} className="mr-1.5" />
            {t('contactSegments.newSegment')}
          </Button>
        }
      />

      <motion.div
        className="grid grid-cols-3 gap-4 mb-6"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        {[
          { label: 'Total Segments', value: segments.length, icon: 'workspaces' },
          { label: 'Total Contacts', value: totalContacts, icon: 'people' },
          { label: 'Dynamic', value: dynamicCount, icon: 'bolt' },
        ].map((stat) => (
          <Card key={stat.label} style={{ ...glassCard, padding: '1rem 1.25rem' }}>
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: 'color-mix(in srgb, var(--color-primary) 10%, transparent)' }}
              >
                <Icon name={stat.icon} size={18} style={{ color: 'var(--color-primary)' }} />
              </div>
              <div>
                <p className="text-xl font-black leading-none" style={gradientTextStyle}>{stat.value}</p>
                <p className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-widest mt-0.5">{stat.label}</p>
              </div>
            </div>
          </Card>
        ))}
      </motion.div>

      {loading && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} style={{ ...glassCard, padding: '1.25rem' }}>
              <div className="flex items-center gap-4">
                <div className="skeleton h-4 rounded w-1/4" />
                <div className="skeleton h-4 rounded w-12" />
                <div className="flex-1" />
                <div className="skeleton h-7 rounded-lg w-20" />
              </div>
            </Card>
          ))}
        </div>
      )}

      {!loading && segments.length > 0 && (
        <motion.div
          className="flex flex-col gap-3"
          variants={stagger}
          initial="hidden"
          animate="visible"
        >
          {segments.map((seg) => (
            <SegmentCard
              key={seg.id}
              segment={seg}
              onEdit={handleEdit}
              onDelete={setDeletingSegment}
              onRefresh={handleRefresh}
            />
          ))}
        </motion.div>
      )}

      {!loading && segments.length === 0 && (
        <motion.div
          className="text-center py-20"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <div
            className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-5"
            style={{
              background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 12%, transparent), color-mix(in srgb, var(--color-tertiary) 10%, transparent))',
              border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)',
            }}
          >
            <Icon name="workspaces" size={36} style={{ color: 'var(--color-primary)' }} />
          </div>
          <h3 className="text-2xl font-black mb-2 font-headline" style={gradientTextStyle}>
            {t('contactSegments.noSegments')}
          </h3>
          <p className="text-sm mb-8 text-on-surface-variant max-w-sm mx-auto">
            {t('contactSegments.noSegmentsDescription')}
          </p>
          <Button
            onClick={handleNew}
            className="px-6 py-3 font-bold text-sm text-white rounded-xl active:scale-95 font-headline"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
          >
            <Icon name="add" size={16} className="mr-1.5" />
            {t('contactSegments.createFirstCta')}
          </Button>
        </motion.div>
      )}

      <SegmentBuilder
        open={builderOpen}
        segment={editingSegment}
        onClose={() => { setBuilderOpen(false); setEditingSegment(null); }}
        onSaved={load}
      />

      <Dialog open={!!deletingSegment} onOpenChange={(open) => { if (!open) setDeletingSegment(null); }}>
        <DialogContent
          className="w-full max-w-md p-0 overflow-hidden rounded-2xl"
          style={{
            background: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(32px) saturate(180%)',
            border: '1px solid rgba(255,255,255,0.7)',
            boxShadow: '0 40px 80px -20px rgba(0,0,0,0.22)',
          }}
        >
          <div className="px-7 pt-7 pb-5" style={{ borderBottom: '1px solid rgba(220,38,38,0.1)', background: 'rgba(220,38,38,0.04)' }}>
            <DialogHeader>
              <DialogTitle className="text-lg font-extrabold font-headline text-red-600">
                Delete Segment
              </DialogTitle>
            </DialogHeader>
          </div>
          <div className="px-7 py-5">
            <p className="text-sm text-on-surface-variant">
              {t('contactSegments.deleteConfirm', { name: deletingSegment?.name ?? '' })}
            </p>
          </div>
          <DialogFooter className="flex gap-3 px-7 pb-7">
            <Button variant="secondary" className="flex-1 rounded-xl" onClick={() => setDeletingSegment(null)}>
              {t('contactSegments.form.cancel')}
            </Button>
            <Button
              variant="destructive"
              className="flex-1 rounded-xl flex items-center justify-center gap-2"
              disabled={deleting}
              onClick={handleDeleteConfirm}
            >
              {deleting ? (
                <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin border-white" />
              ) : (
                <><Icon name="delete" size={14} className="mr-1" />Delete</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
