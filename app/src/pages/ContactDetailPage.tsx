import { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Contact, ActivityItem, ContactSegment } from '../types';

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

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function LinkedByBadge({ linkedBy }: { linkedBy?: string }) {
  const { t } = useTranslation();
  const label = linkedBy === 'auto'   ? t('contactDetail.activity.linkedBy.auto')
              : linkedBy === 'token'  ? t('contactDetail.activity.linkedBy.token')
              : linkedBy === 'manual' ? t('contactDetail.activity.linkedBy.manual')
              : null;
  if (!label) return null;
  return (
    <span
      className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
      style={{ background: 'color-mix(in srgb, var(--color-primary) 10%, transparent)', color: 'var(--color-primary)' }}
    >
      {label}
    </span>
  );
}

function SeverityChip({ severity }: { severity?: string }) {
  if (!severity) return null;
  const colors: Record<string, { bg: string; text: string }> = {
    critical: { bg: 'rgba(220,38,38,0.1)',  text: '#dc2626' },
    high:     { bg: 'rgba(217,119,6,0.1)',  text: '#d97706' },
    medium:   { bg: 'rgba(42,75,217,0.1)',  text: '#2a4bd9' },
    low:      { bg: 'rgba(5,150,105,0.1)',  text: '#059669' },
  };
  const c = colors[severity] ?? { bg: 'rgba(100,116,139,0.1)', text: '#475569' };
  return (
    <span
      className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full capitalize"
      style={{ background: c.bg, color: c.text }}
    >
      {severity}
    </span>
  );
}

function StatusChip({ status }: { status?: string }) {
  if (!status) return null;
  return (
    <span
      className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full capitalize"
      style={{ background: 'rgba(100,116,139,0.1)', color: '#475569' }}
    >
      {status.replace('_', ' ')}
    </span>
  );
}

function ActivityTab({ timeline }: { timeline: ActivityItem[] }) {
  const { t } = useTranslation();

  if (timeline.length === 0) {
    return (
      <div className="text-center py-12">
        <Icon name="timeline" size={36} className="mx-auto mb-3 text-on-surface-variant opacity-40" />
        <p className="text-sm text-on-surface-variant">{t('contactDetail.noActivity')}</p>
      </div>
    );
  }

  return (
    <motion.div
      className="relative pl-6"
      variants={stagger}
      initial="hidden"
      animate="visible"
    >
      <div
        className="absolute left-2.5 top-2 bottom-2 w-px"
        style={{ background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)' }}
      />

      {timeline.map((item) => (
        <motion.div key={`${item.type}-${item.id}`} variants={rise} className="mb-4 relative">
          <div
            className="absolute -left-4 top-1 w-2 h-2 rounded-full"
            style={{ background: item.type === 'response' ? 'var(--color-primary)' : '#d97706' }}
          />

          <Card style={{ ...glassCard, padding: '0.875rem 1rem' }}>
            <div className="flex items-start gap-3">
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                style={{
                  background: item.type === 'response' ? 'color-mix(in srgb, var(--color-primary) 10%, transparent)' : 'rgba(217,119,6,0.1)',
                }}
              >
                <Icon
                  name={item.type === 'response' ? 'description' : 'support_agent'}
                  size={14}
                  style={{ color: item.type === 'response' ? 'var(--color-primary)' : '#d97706' }}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-on-surface">
                    {item.type === 'response'
                      ? (item.survey_title ?? t('contactDetail.activity.response'))
                      : (item.title ?? t('contactDetail.activity.case'))}
                  </span>
                  {item.type === 'response' && <LinkedByBadge linkedBy={item.linked_by} />}
                  {item.type === 'case' && (
                    <>
                      <SeverityChip severity={item.severity} />
                      <StatusChip status={item.status} />
                    </>
                  )}
                </div>
                <p className="text-xs text-on-surface-variant mt-0.5">
                  {formatRelativeTime(item.ts)}
                </p>
              </div>
            </div>
          </Card>
        </motion.div>
      ))}
    </motion.div>
  );
}

function SegmentsTab({ segments, onRemove }: { segments: ContactSegment[]; onRemove: (segId: string) => void }) {
  const { t } = useTranslation();

  if (segments.length === 0) {
    return (
      <div className="text-center py-12">
        <Icon name="workspaces" size={36} className="mx-auto mb-3 text-on-surface-variant opacity-40" />
        <p className="text-sm text-on-surface-variant">{t('contactDetail.segments.noSegments')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-3 pt-2">
      {segments.map((seg) => (
        <div
          key={seg.id}
          className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium"
          style={{
            background: 'rgba(255,255,255,0.8)',
            border: `2px solid ${seg.color}30`,
            boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
          }}
        >
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: seg.color }} />
          <span className="text-on-surface">{seg.name}</span>
          <span className="text-xs text-on-surface-variant">
            {t('contactSegments.contactCount', { count: String(seg.contact_count) })}
          </span>
          <button
            onClick={() => onRemove(seg.id)}
            className="ml-1 text-on-surface-variant hover:text-red-500 transition-colors"
            title={t('contactDetail.segments.removeFromSegment')}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function ResponsesTab({ timeline }: { timeline: ActivityItem[] }) {
  const { t } = useTranslation();
  const responses = timeline.filter((i) => i.type === 'response');

  if (responses.length === 0) {
    return (
      <div className="text-center py-12">
        <Icon name="description" size={36} className="mx-auto mb-3 text-on-surface-variant opacity-40" />
        <p className="text-sm text-on-surface-variant">{t('contactDetail.responses.noResponses')}</p>
      </div>
    );
  }

  return (
    <motion.div className="flex flex-col gap-3" variants={stagger} initial="hidden" animate="visible">
      {responses.map((item) => (
        <motion.div key={item.id} variants={rise}>
          <Card style={{ ...glassCard, padding: '0.875rem 1rem' }}>
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: 'color-mix(in srgb, var(--color-primary) 10%, transparent)' }}
              >
                <Icon name="description" size={16} style={{ color: 'var(--color-primary)' }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-on-surface truncate">
                  {item.survey_title ?? 'Survey Response'}
                </p>
                <p className="text-xs text-on-surface-variant mt-0.5">{formatRelativeTime(item.ts)}</p>
              </div>
              <LinkedByBadge linkedBy={item.linked_by} />
              {item.survey_id && (
                <Link
                  to={toPath(ROUTES.RESPONSE_DASHBOARD, { surveyId: item.survey_id })}
                  className="text-xs font-bold px-3 py-1.5 rounded-lg"
                  style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))', color: '#fff' }}
                >
                  {t('contactDetail.responses.viewResponse')}
                </Link>
              )}
            </div>
          </Card>
        </motion.div>
      ))}
    </motion.div>
  );
}

export function ContactDetailPage() {
  const { t } = useTranslation();
  const { contactId } = useParams<{ contactId: string }>();
  const navigate = useNavigate();
  const api = useApi();

  const [contact, setContact] = useState<Contact | null>(null);
  const [timeline, setTimeline] = useState<ActivityItem[]>([]);
  const [segments, setSegments] = useState<ContactSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [anonymizing, setAnonymizing] = useState(false);
  const [showAnonymizeConfirm, setShowAnonymizeConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState('activity');

  const contactName = contact?.name ?? contact?.email ?? t('contactDetail.title');
  useSetPageTitle(contactName, t('contactDetail.title'));

  const load = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);
    setError(null);
    try {
      const [c, activity] = await Promise.all([
        api.getContact(contactId),
        api.getContactActivity(contactId),
      ]);
      setContact(c);
      setTimeline(activity.timeline);
      setSegments(activity.segments);
    } catch (err) {
      console.error('[ContactDetailPage] load error', err);
      setError('Contact not found or could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [api, contactId]);

  useEffect(() => { load(); }, [load]);
  useInvalidation('contacts', load);

  async function handleAnonymize() {
    if (!contact) return;
    setAnonymizing(true);
    try {
      await api.anonymizeContact(contact.id);
      setShowAnonymizeConfirm(false);
      await load();
    } catch (err) {
      console.error('[ContactDetailPage] anonymize error', err);
    } finally {
      setAnonymizing(false);
    }
  }

  async function handleRemoveFromSegment(segId: string) {
    if (!contact) return;
    try {
      await api.removeSegmentMember(segId, contact.id);
      setSegments((prev) => prev.filter((s) => s.id !== segId));
    } catch (err) {
      console.error('[ContactDetailPage] remove segment error', err);
    }
  }

  async function handleCreateCase() {
    if (!contact) return;
    try {
      const created = await api.createCase({
        contact_id: contact.id,
        title: `Case for ${contact.name ?? contact.email ?? 'contact'}`,
        category: 'General',
        status: 'open',
        severity: 'medium',
      });
      navigate(toPath(ROUTES.CASE_DETAIL, { caseId: created.id }));
    } catch (err) {
      console.error('[ContactDetailPage] createCase error', err);
    }
  }

  const displayName  = contact?.name  ?? '****';
  const displayEmail = contact?.email ?? '****';
  const displayPhone = contact?.phone ?? null;
  const avatarInitial = (contact?.name && contact.name !== '****') ? contact.name.charAt(0).toUpperCase() : '?';
  const isAnonymized  = !!contact?.anonymized_at;

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto w-full">
        <div className="flex items-center justify-center py-32">
          <div
            className="w-8 h-8 rounded-full border-2 animate-spin"
            style={{
              borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)',
              borderTopColor: 'var(--color-primary)',
            }}
          />
        </div>
      </div>
    );
  }

  if (error || !contact) {
    return (
      <div className="max-w-7xl mx-auto w-full">
        <div className="text-center py-24">
          <Icon name="error_outline" size={48} className="mx-auto mb-4 text-on-surface-variant opacity-40" />
          <h3 className="text-xl font-bold text-on-surface mb-2">Contact not found</h3>
          <p className="text-sm text-on-surface-variant mb-6">{error}</p>
          <Button variant="outline" onClick={() => navigate(ROUTES.CONTACTS)}>
            <Icon name="arrow_back" size={16} className="mr-1.5" />
            Back to Contacts
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: t('contacts.title'), path: ROUTES.CONTACTS },
          { label: displayName },
        ]}
        title={displayName}
        subtitle={displayEmail}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handleCreateCase}>
              <Icon name="add_circle" size={16} className="mr-1.5" />
              {t('contactDetail.createCase')}
            </Button>
            {!isAnonymized && (
              <Button variant="destructive" onClick={() => setShowAnonymizeConfirm(true)}>
                <Icon name="person_off" size={16} className="mr-1.5" />
                {t('contactDetail.anonymizeButton')}
              </Button>
            )}
          </div>
        }
      />

      {isAnonymized && (
        <motion.div
          className="mb-6 flex items-center gap-3 px-5 py-3.5 rounded-2xl"
          style={{ background: 'rgba(100,116,139,0.1)', border: '1px solid rgba(100,116,139,0.2)' }}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          <Icon name="lock" size={18} className="text-on-surface-variant" />
          <span className="text-sm font-medium text-on-surface-variant">{t('contactDetail.anonymized')}</span>
        </motion.div>
      )}

      <motion.div
        className="mb-6"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <Card style={glassCard}>
          <div className="p-6 flex flex-col sm:flex-row items-start sm:items-center gap-5">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center shrink-0 font-black text-xl text-white shadow-lg"
              style={{ background: isAnonymized ? 'rgba(100,116,139,0.3)' : 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
            >
              {avatarInitial}
            </div>

            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-black tracking-tight font-headline" style={isAnonymized ? { color: '#94a3b8' } : gradientTextStyle}>
                {displayName}
              </h2>
              <p className="text-sm text-on-surface-variant mt-0.5">{displayEmail}</p>
              {displayPhone && (
                <p className="text-sm text-on-surface-variant mt-0.5">
                  <Icon name="phone" size={12} className="inline mr-1" />
                  {displayPhone}
                </p>
              )}
              {contact.account_name && (
                <span
                  className="inline-flex items-center gap-1 text-xs font-medium mt-2 px-2.5 py-1 rounded-full"
                  style={{ background: 'color-mix(in srgb, var(--color-secondary) 10%, transparent)', color: 'var(--color-secondary)' }}
                >
                  <Icon name="business" size={11} className="inline shrink-0" />
                  {contact.account_name}
                </span>
              )}
            </div>

            <div className="flex flex-col items-end gap-2 shrink-0">
              <Badge
                className="text-xs px-2.5 py-1 rounded-full font-medium"
                style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)', color: 'var(--color-primary)' }}
              >
                <Icon name="public" size={11} className="inline mr-1" />
                {contact.data_region}
              </Badge>
              {isAnonymized ? (
                <Badge className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: 'rgba(100,116,139,0.12)', color: '#475569' }}>
                  {t('contacts.anonymized')}
                </Badge>
              ) : contact.consent_given ? (
                <Badge className="text-xs px-2.5 py-1 rounded-full font-medium flex items-center gap-1" style={{ background: '#d1fae5', color: '#065f46' }}>
                  <Icon name="check_circle" size={11} className="inline shrink-0" />
                  {t('contacts.consentGiven')}
                </Badge>
              ) : (
                <Badge className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: 'rgba(100,116,139,0.12)', color: '#475569' }}>
                  {t('contacts.consentPending')}
                </Badge>
              )}
            </div>
          </div>
        </Card>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
      >
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList
            className="mb-6 p-1 rounded-xl"
            style={{ background: 'rgba(255,255,255,0.7)', border: '1px solid color-mix(in srgb, var(--color-primary) 10%, transparent)' }}
          >
            <TabsTrigger value="activity">{t('contactDetail.tabs.activity')}</TabsTrigger>
            <TabsTrigger value="segments">{t('contactDetail.tabs.segments')}</TabsTrigger>
            <TabsTrigger value="responses">{t('contactDetail.tabs.responses')}</TabsTrigger>
          </TabsList>

          <TabsContent value="activity">
            <ActivityTab timeline={timeline} />
          </TabsContent>
          <TabsContent value="segments">
            <SegmentsTab segments={segments} onRemove={handleRemoveFromSegment} />
          </TabsContent>
          <TabsContent value="responses">
            <ResponsesTab timeline={timeline} />
          </TabsContent>
        </Tabs>
      </motion.div>

      <Dialog open={showAnonymizeConfirm} onOpenChange={(open) => { if (!open) setShowAnonymizeConfirm(false); }}>
        <DialogContent
          className="w-full max-w-md p-0 overflow-hidden rounded-2xl"
          style={{
            background: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(32px) saturate(180%)',
            border: '1px solid rgba(255,255,255,0.7)',
            boxShadow: '0 40px 80px -20px rgba(0,0,0,0.22)',
          }}
        >
          <div className="px-7 pt-7 pb-5" style={{ background: 'rgba(220,38,38,0.04)', borderBottom: '1px solid rgba(220,38,38,0.1)' }}>
            <DialogHeader>
              <DialogTitle className="text-lg font-extrabold tracking-tight font-headline text-red-600">
                {t('contactDetail.anonymizeButton')}
              </DialogTitle>
            </DialogHeader>
          </div>
          <div className="px-7 py-5">
            <p className="text-sm text-on-surface-variant">{t('contactDetail.anonymizeConfirm')}</p>
          </div>
          <DialogFooter className="flex gap-3 px-7 pb-7">
            <Button variant="secondary" className="flex-1 rounded-xl" onClick={() => setShowAnonymizeConfirm(false)}>
              {t('contactSegments.form.cancel')}
            </Button>
            <Button
              variant="destructive"
              className="flex-1 rounded-xl flex items-center justify-center gap-2"
              disabled={anonymizing}
              onClick={handleAnonymize}
            >
              {anonymizing ? (
                <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin border-white" />
              ) : (
                <>{t('contactDetail.anonymizeButton')}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
