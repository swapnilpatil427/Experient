import { useState, useEffect, useCallback } from 'react';
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
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { Contact } from '../types';

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

const glassCardHover: React.CSSProperties = {
  boxShadow: '0 20px 40px -8px color-mix(in srgb, var(--color-primary) 14%, transparent), inset 0 1px 0 rgba(255,255,255,0.8)',
  transform: 'perspective(1000px) rotateX(2deg) rotateY(-1deg)',
};

const gradientTextStyle: React.CSSProperties = {
  background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  backgroundClip: 'text',
};

function ContactCard({ contact }: { contact: Contact }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);

  const displayName = contact.name ?? '****';
  const displayEmail = contact.email ?? '****';
  const isPiiMasked = contact.name === null || contact.email === null;
  const avatarInitial = displayName !== '****' ? displayName.charAt(0).toUpperCase() : '?';

  const segmentKeys = Object.keys(contact.segment_attrs ?? {}).slice(0, 2);

  return (
    <motion.div variants={rise}>
      <Card
        style={{
          ...glassCard,
          ...(hovered ? glassCardHover : {}),
          transition: 'box-shadow 0.3s ease, transform 0.3s ease',
          overflow: 'hidden',
          border: hovered ? '1px solid color-mix(in srgb, var(--color-primary) 18%, transparent)' : '1px solid rgba(255,255,255,0.6)',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="flex items-center gap-4 p-5">
          {/* Avatar */}
          <div
            className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 font-bold text-sm text-white shadow-md"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
          >
            {avatarInitial}
          </div>

          {/* Identity */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {isPiiMasked ? (
                <span className="font-semibold text-on-surface-variant flex items-center gap-1.5 text-sm">
                  <Icon name="lock" size={13} className="text-on-surface-variant" />
                  Protected
                </span>
              ) : (
                <span className="font-semibold text-on-surface truncate text-sm">
                  {displayName}
                </span>
              )}
              {isPiiMasked && (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-default" />
                    </TooltipTrigger>
                    <TooltipContent>{t('contacts.piiProtected')}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
            <p className="text-xs text-on-surface-variant truncate mt-0.5">{displayEmail}</p>
            {contact.account_name && (
              <span
                className="inline-flex items-center gap-1 text-xs font-medium mt-1.5 px-2 py-0.5 rounded-full"
                style={{ background: 'color-mix(in srgb, var(--color-secondary) 10%, transparent)', color: 'var(--color-secondary)' }}
              >
                <Icon name="business" size={10} className="inline shrink-0" />
                {contact.account_name}
              </span>
            )}
          </div>

          {/* Right: badges */}
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            {/* Consent badge */}
            {contact.anonymized_at ? (
              <Badge
                className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                style={{ background: 'rgba(100,116,139,0.12)', color: '#475569' }}
              >
                {t('contacts.anonymized')}
              </Badge>
            ) : contact.consent_given ? (
              <Badge
                className="text-[10px] px-2 py-0.5 rounded-full font-medium flex items-center gap-0.5"
                style={{ background: '#d1fae5', color: '#065f46' }}
              >
                <Icon name="check_circle" size={10} className="inline shrink-0" />
                {t('contacts.consentGiven')}
              </Badge>
            ) : (
              <Badge
                className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                style={{ background: 'rgba(100,116,139,0.12)', color: '#475569' }}
              >
                {t('contacts.consentPending')}
              </Badge>
            )}

            {/* Segment chips */}
            {segmentKeys.map((key) => (
              <Badge
                key={key}
                className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)', color: 'var(--color-primary)' }}
              >
                {contact.segment_attrs[key]}
              </Badge>
            ))}
          </div>

          {/* View CTA */}
          <Link
            to={toPath(ROUTES.CONTACT_DETAIL, { contactId: contact.id })}
            className="ml-2 shrink-0"
          >
            <span
              className="text-xs font-bold px-3 py-1.5 rounded-lg transition-opacity hover:opacity-80 active:scale-95 inline-flex items-center gap-1"
              style={{
                background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
                color: '#fff',
              }}
            >
              <Icon name="arrow_forward" size={12} className="shrink-0" />
              {t('contacts.viewContact')}
            </span>
          </Link>
        </div>
      </Card>
    </motion.div>
  );
}

function SkeletonCard() {
  return (
    <Card style={{ ...glassCard, padding: '1.25rem' }}>
      <div className="flex items-center gap-4">
        <div className="skeleton w-11 h-11 rounded-full" />
        <div className="flex-1 space-y-2">
          <div className="skeleton h-4 rounded w-1/3" />
          <div className="skeleton h-3 rounded w-1/2" />
        </div>
        <div className="skeleton h-5 w-16 rounded-full" />
      </div>
    </Card>
  );
}

interface ContactImportResult {
  created: number;
  updated: number;
  errors: Array<{ index: number; message: string }>;
}

function friendlyImportError(message: string, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (message.includes('unique or exclusion constraint')) return t('contacts.import.errorMigration');
  if (message.includes('data:pii')) return t('contacts.import.errorPii');
  if (message.includes('23505') || message.toLowerCase().includes('duplicate')) {
    return t('contacts.import.errorDuplicate');
  }
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}

export function ContactsPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('contacts.title'), t('contacts.subtitle'));
  const api = useApi();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [consentFilter, setConsentFilter] = useState<'all' | 'given' | 'pending'>('all');

  const [showImport, setShowImport] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ContactImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const resetImportDialog = useCallback(() => {
    setCsvText('');
    setImportResult(null);
    setImportError(null);
  }, []);

  const closeImportDialog = useCallback(() => {
    setShowImport(false);
    resetImportDialog();
  }, [resetImportDialog]);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listContacts({ search: search || undefined, limit: 50 });
      let list = result.contacts;
      if (consentFilter === 'given')   list = list.filter((c) => c.consent_given && !c.anonymized_at);
      if (consentFilter === 'pending') list = list.filter((c) => !c.consent_given);
      setContacts(list);
      setTotal(result.total);
    } catch {
      setContacts([]);
    } finally {
      setLoading(false);
    }
  }, [api, search, consentFilter]);

  useEffect(() => {
    const timer = setTimeout(loadContacts, search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [loadContacts, search]);

  useInvalidation('contacts', loadContacts);

  async function handleImport() {
    if (!csvText.trim()) return;
    setImporting(true);
    setImportResult(null);
    setImportError(null);
    try {
      const lines = csvText.trim().split('\n').filter((l) => l.trim());
      const dataLines = lines[0]?.toLowerCase().includes('name') ? lines.slice(1) : lines;
      const parsed = dataLines.map((line) => {
        const parts = line.split(',').map((s) => s.trim());
        return { name: parts[0] || undefined, email: parts[1] || undefined, account_name: parts[2] || undefined };
      });
      const result = await api.importContacts(parsed);
      setImportResult(result);
      const failed = result.errors.length;
      const succeeded = result.created + result.updated;
      if (succeeded > 0) loadContacts();
      if (succeeded > 0 && failed === 0) {
        setCsvText('');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setImportError(t('contacts.import.requestFailed', { message }));
    } finally {
      setImporting(false);
    }
  }

  const importFailedCount = importResult?.errors.length ?? 0;
  const importSucceededCount = (importResult?.created ?? 0) + (importResult?.updated ?? 0);
  const importAllSucceeded = importResult !== null && importFailedCount === 0 && importSucceededCount > 0;
  const importAllFailed = importResult !== null && importSucceededCount === 0 && importFailedCount > 0;
  const importPartial = importResult !== null && importSucceededCount > 0 && importFailedCount > 0;

  const consentCount = contacts.filter((c) => c.consent_given && !c.anonymized_at).length;
  const linkedCount = contacts.filter((c) => c.segment_attrs && Object.keys(c.segment_attrs).length > 0).length;

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[{ label: t('contacts.title'), icon: 'contacts', path: ROUTES.CONTACTS }]}
        title={t('contacts.title')}
        subtitle={t('contacts.subtitle')}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setShowImport(true)}>
              <Icon name="upload_file" size={16} className="mr-1.5" />
              {t('contacts.importCsv')}
            </Button>
            <Button
              onClick={() => setShowImport(true)}
              className="font-bold text-sm text-white rounded-xl px-5 py-2.5 active:scale-95"
              style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
            >
              <Icon name="person_add" size={16} className="mr-1.5" />
              {t('contacts.addContact')}
            </Button>
          </div>
        }
      />

      {/* Nav strip: All Contacts | Segments | Connections */}
      <div className="flex items-center gap-2 mb-6">
        <span
          className="text-xs font-bold px-3 py-1.5 rounded-lg inline-flex items-center gap-1"
          style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))', color: '#fff' }}
        >
          <Icon name="contacts" size={12} />
          {t('contacts.allContacts')}
        </span>
        <Link to={ROUTES.CONTACT_SEGMENTS}>
          <span
            className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80 inline-flex items-center gap-1"
            style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)', color: 'var(--color-primary)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }}
          >
            <Icon name="workspaces" size={12} />
            {t('contacts.segments')}
          </span>
        </Link>
        <Link to={ROUTES.SETTINGS_CONNECTIONS} className="ml-auto">
          <span
            className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80 inline-flex items-center gap-1"
            style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)', color: 'var(--color-primary)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }}
          >
            <Icon name="cable" size={12} />
            {t('contacts.connections')}
          </span>
        </Link>
      </div>

      {/* Hero Banner */}
      <motion.div
        className="mb-6"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <div
          style={{
            background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 6%, transparent) 0%, color-mix(in srgb, var(--color-tertiary) 4%, transparent) 50%, color-mix(in srgb, var(--color-secondary) 4%, transparent) 100%), rgba(255,255,255,0.6)',
            border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)',
            borderRadius: '1.25rem',
            padding: '1.5rem',
            backdropFilter: 'blur(20px)',
          }}
        >
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            {/* Left: title + subtitle */}
            <div>
              <h2 className="text-2xl font-black tracking-tight font-headline mb-1" style={gradientTextStyle}>
                Contact Intelligence Hub
              </h2>
              <p className="text-sm text-on-surface-variant">{t('contacts.subtitle')}</p>
            </div>

            {/* Right: stat chips */}
            <div className="flex items-center gap-3 flex-wrap">
              {/* Total contacts */}
              <div
                className="flex flex-col items-center px-4 py-2 rounded-xl"
                style={{ background: 'rgba(255,255,255,0.7)', border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)' }}
              >
                <span className="text-xl font-black leading-none" style={gradientTextStyle}>
                  {total}
                </span>
                <span className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-widest mt-0.5">
                  Total
                </span>
              </div>

              {/* Consent count */}
              <div
                className="flex flex-col items-center px-4 py-2 rounded-xl"
                style={{ background: 'rgba(255,255,255,0.7)', border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)' }}
              >
                <span className="text-xl font-black leading-none" style={{ ...gradientTextStyle }}>
                  {consentCount}
                </span>
                <span className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-widest mt-0.5">
                  Consented
                </span>
              </div>

              {/* Linked (has segment attrs) */}
              <div
                className="flex flex-col items-center px-4 py-2 rounded-xl"
                style={{ background: 'rgba(255,255,255,0.7)', border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)' }}
              >
                <span className="text-xl font-black leading-none" style={gradientTextStyle}>
                  {linkedCount}
                </span>
                <span className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-widest mt-0.5">
                  Segmented
                </span>
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Filter bar */}
      <div
        className="flex flex-col md:flex-row gap-3 mb-6 p-4 rounded-2xl"
        style={{
          background: 'rgba(255,255,255,0.65)',
          backdropFilter: 'blur(20px)',
          border: '1px solid color-mix(in srgb, var(--color-primary) 10%, transparent)',
        }}
      >
        <div className="relative flex-1">
          <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('contacts.searchPlaceholder')}
            className="pl-9 rounded-xl"
            style={{
              background: 'rgba(255,255,255,0.7)',
              border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)',
            }}
          />
        </div>
        <Select value={consentFilter} onValueChange={(v) => setConsentFilter(v as 'all' | 'given' | 'pending')}>
          <SelectTrigger
            className="w-44 rounded-xl"
            style={{
              background: 'rgba(255,255,255,0.7)',
              border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)',
            }}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('contacts.filterConsentAll')}</SelectItem>
            <SelectItem value="given">{t('contacts.filterConsentGiven')}</SelectItem>
            <SelectItem value="pending">{t('contacts.filterConsentPending')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Loading skeletons */}
      {loading && (
        <div className="flex flex-col gap-3" aria-label={t('contacts.skeletonAria')}>
          {[0, 1, 2].map((i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {/* Contact list */}
      {!loading && contacts.length > 0 && (
        <motion.div
          className="flex flex-col gap-3"
          variants={stagger}
          initial="hidden"
          animate="visible"
        >
          {contacts.map((contact) => (
            <ContactCard key={contact.id} contact={contact} />
          ))}
        </motion.div>
      )}

      {/* Empty state */}
      {!loading && contacts.length === 0 && (
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
            <Icon name="contacts" size={36} style={{ color: 'var(--color-primary)' }} />
          </div>
          <h3
            className="text-2xl font-black mb-2 font-headline"
            style={gradientTextStyle}
          >
            {t('contacts.noContacts')}
          </h3>
          <p className="text-sm mb-8 text-on-surface-variant max-w-sm mx-auto">
            {t('contacts.noContactsDescription')}
          </p>
          <Button
            onClick={() => setShowImport(true)}
            className="px-6 py-3 font-bold text-sm text-white rounded-xl active:scale-95 font-headline"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
          >
            <Icon name="upload_file" size={16} className="mr-1.5" />
            {t('contacts.importFirstCta')}
          </Button>
        </motion.div>
      )}

      {/* Import Modal */}
      <Dialog open={showImport} onOpenChange={(open) => { if (!open) closeImportDialog(); else setShowImport(true); }}>
        <DialogContent
          className="w-full max-w-lg p-0 overflow-hidden rounded-2xl"
          style={{
            background: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(32px) saturate(180%)',
            border: '1px solid rgba(255,255,255,0.7)',
            boxShadow: '0 40px 80px -20px rgba(0,0,0,0.22)',
          }}
        >
          {/* Gradient header accent */}
          <div
            className="px-8 pt-8 pb-5"
            style={{
              background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 6%, transparent) 0%, color-mix(in srgb, var(--color-tertiary) 4%, transparent) 100%)',
              borderBottom: '1px solid color-mix(in srgb, var(--color-primary) 10%, transparent)',
            }}
          >
            <DialogHeader>
              <DialogTitle className="text-xl font-extrabold tracking-tight font-headline" style={gradientTextStyle}>
                {t('contacts.import.title')}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-on-surface-variant mt-1">{t('contacts.import.description')}</p>
          </div>

          <div className="px-8 py-6 space-y-4">
            <Label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">
              {t('contacts.import.pasteLabel')}
            </Label>
            <Textarea
              value={csvText}
              onChange={(e) => { setCsvText(e.target.value); setImportResult(null); setImportError(null); }}
              placeholder={t('contacts.import.pastePlaceholder')}
              className="w-full min-h-[120px] rounded-xl text-sm font-mono resize-y"
              style={{
                background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)',
              }}
              autoFocus
            />

            <AnimatePresence mode="wait">
              {importError && (
                <motion.div
                  key="import-request-error"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="rounded-xl border px-4 py-3 flex gap-3"
                  style={{ background: '#fef2f2', borderColor: '#fecaca' }}
                  role="alert"
                >
                  <Icon name="error_outline" size={20} className="shrink-0 mt-0.5" style={{ color: '#dc2626' }} />
                  <p className="text-sm leading-relaxed" style={{ color: '#991b1b' }}>{importError}</p>
                </motion.div>
              )}

              {importResult && (
                <motion.div
                  key="import-result"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="space-y-3"
                >
                  {(importAllSucceeded || importPartial) && (
                    <div
                      className="rounded-xl border px-4 py-3 flex gap-3"
                      style={{
                        background: importPartial ? '#fffbeb' : '#ecfdf5',
                        borderColor: importPartial ? '#fde68a' : '#a7f3d0',
                      }}
                      role="status"
                    >
                      <Icon
                        name={importPartial ? 'warning' : 'check_circle'}
                        size={20}
                        className="shrink-0 mt-0.5"
                        style={{ color: importPartial ? '#d97706' : '#059669' }}
                      />
                      <p className="text-sm font-medium leading-relaxed" style={{ color: importPartial ? '#92400e' : '#065f46' }}>
                        {importPartial
                          ? t('contacts.import.partialSuccess', {
                              created: importResult.created,
                              updated: importResult.updated,
                              failed: importFailedCount,
                            })
                          : t('contacts.import.successMessage', {
                              created: importResult.created,
                              updated: importResult.updated,
                            })}
                      </p>
                    </div>
                  )}

                  {importAllFailed && (
                    <div
                      className="rounded-xl border px-4 py-3 flex gap-3"
                      style={{ background: '#fef2f2', borderColor: '#fecaca' }}
                      role="alert"
                    >
                      <Icon name="error_outline" size={20} className="shrink-0 mt-0.5" style={{ color: '#dc2626' }} />
                      <p className="text-sm font-semibold" style={{ color: '#991b1b' }}>{t('contacts.import.allFailed')}</p>
                    </div>
                  )}

                  {importFailedCount > 0 && (
                    <div
                      className="rounded-xl border overflow-hidden"
                      style={{ borderColor: 'rgba(220,38,38,0.2)', background: 'rgba(254,242,242,0.5)' }}
                    >
                      <div className="px-4 py-2.5 border-b text-xs font-bold uppercase tracking-widest"
                        style={{ borderColor: 'rgba(220,38,38,0.15)', color: '#991b1b' }}
                      >
                        {t('contacts.import.errorsHeading', { count: importFailedCount })}
                      </div>
                      <ScrollArea className="max-h-40">
                        <ul className="px-4 py-2 space-y-2">
                          {importResult.errors.map((err) => (
                            <li
                              key={err.index}
                              className="text-xs font-mono leading-relaxed flex gap-2"
                              style={{ color: '#7f1d1d' }}
                            >
                              <span className="shrink-0 font-bold tabular-nums">#{err.index + 1}</span>
                              <span>{friendlyImportError(err.message, t)}</span>
                            </li>
                          ))}
                        </ul>
                      </ScrollArea>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <DialogFooter className="flex gap-3 px-8 pb-8">
            <Button
              variant="secondary"
              onClick={closeImportDialog}
              className="flex-1 py-3 font-bold text-sm rounded-xl font-headline"
            >
              {importAllSucceeded ? t('contacts.import.done') : t('contacts.import.cancel')}
            </Button>
            {importAllSucceeded ? null : (
            <Button
              onClick={handleImport}
              disabled={!csvText.trim() || importing}
              className="flex-1 py-3 font-bold text-sm text-white rounded-xl active:scale-95 font-headline flex items-center justify-center gap-2"
              style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
            >
              {importing ? (
                <>
                  <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin border-white" />
                  {t('contacts.import.importing')}
                </>
              ) : (
                <>
                  <Icon name={importResult ? 'refresh' : 'upload'} size={16} />
                  {importResult ? t('contacts.import.tryAgain') : t('contacts.import.importButton')}
                </>
              )}
            </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
