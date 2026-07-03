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
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { SyncConfig, SyncLog, SyncProvider, FieldMapping } from '../types';

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
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const PROVIDER_META: Record<SyncProvider, { label: string; initials: string; bg: string; text: string }> = {
  hubspot:    { label: 'HubSpot CRM',       initials: 'HS',  bg: '#ff7a59', text: '#fff' },
  salesforce: { label: 'Salesforce',         initials: 'SF',  bg: '#0070d2', text: '#fff' },
  csv_url:    { label: 'CSV from URL',       initials: 'CSV', bg: '#64748b', text: '#fff' },
  webhook:    { label: 'Inbound Webhook',    initials: 'WH',  bg: '#7c3aed', text: '#fff' },
};

const DEST_FIELD_OPTIONS = [
  'email', 'name', 'phone', 'account_name', 'account_id', 'external_id',
];

const DEFAULT_MAPPINGS: Record<SyncProvider, FieldMapping[]> = {
  hubspot:    [{ source: 'email', dest: 'email' }, { source: 'firstname', dest: 'name' }, { source: 'phone', dest: 'phone' }, { source: 'company', dest: 'account_name' }],
  salesforce: [{ source: 'Email', dest: 'email' }, { source: 'Name', dest: 'name' }, { source: 'Phone', dest: 'phone' }, { source: 'Account.Name', dest: 'account_name' }],
  csv_url:    [{ source: 'email', dest: 'email' }, { source: 'name', dest: 'name' }],
  webhook:    [{ source: 'email', dest: 'email' }, { source: 'name', dest: 'name' }],
};

function ProviderBadge({ provider }: { provider: SyncProvider }) {
  const meta = PROVIDER_META[provider];
  return (
    <div
      className="w-9 h-9 rounded-xl flex items-center justify-center text-xs font-black shrink-0"
      style={{ background: meta.bg, color: meta.text }}
    >
      {meta.initials}
    </div>
  );
}

function StatusChip({ status }: { status?: SyncConfig['last_sync_status'] }) {
  const { t } = useTranslation();
  if (!status) return null;
  const styles: Record<string, { bg: string; text: string }> = {
    running:   { bg: 'rgba(217,119,6,0.1)',   text: '#d97706' },
    completed: { bg: 'rgba(5,150,105,0.1)',   text: '#059669' },
    failed:    { bg: 'rgba(220,38,38,0.1)',   text: '#dc2626' },
  };
  const s = styles[status] ?? styles.running;
  return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize" style={{ background: s.bg, color: s.text }}>
      {t(`syncConnections.status.${status}`)}
    </span>
  );
}

interface LogsSheetProps {
  config: SyncConfig | null;
  onClose: () => void;
}

function LogsSheet({ config, onClose }: LogsSheetProps) {
  const { t } = useTranslation();
  const api = useApi();
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!config) return;
    setLoading(true);
    api.getSyncLogs(config.id)
      .then(setLogs)
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, [config, api]);

  return (
    <Sheet open={!!config} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto" style={{ background: 'rgba(255,255,255,0.96)', backdropFilter: 'blur(32px)' }}>
        <SheetHeader className="mb-5">
          <SheetTitle className="text-lg font-black font-headline" style={gradientTextStyle}>
            {t('syncConnections.logs.heading')}
          </SheetTitle>
          {config && <p className="text-sm text-on-surface-variant">{config.name}</p>}
        </SheetHeader>

        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 rounded-full border-2 animate-spin" style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', borderTopColor: 'var(--color-primary)' }} />
          </div>
        )}

        {!loading && logs.length === 0 && (
          <p className="text-sm text-center text-on-surface-variant py-12">{t('syncConnections.logs.noLogs')}</p>
        )}

        {!loading && logs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-on-surface-variant">
                  <th className="text-left py-2 pr-3 font-semibold">{t('syncConnections.logs.date')}</th>
                  <th className="text-right py-2 pr-3 font-semibold">{t('syncConnections.logs.fetched')}</th>
                  <th className="text-right py-2 pr-3 font-semibold">{t('syncConnections.logs.created')}</th>
                  <th className="text-right py-2 pr-3 font-semibold">{t('syncConnections.logs.updated')}</th>
                  <th className="text-right py-2 pr-3 font-semibold">{t('syncConnections.logs.failed')}</th>
                  <th className="text-left py-2 font-semibold">{t('syncConnections.logs.status')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-on-surface-variant/10">
                    <td className="py-2 pr-3 text-on-surface-variant">{new Date(log.started_at).toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right text-on-surface">{log.contacts_fetched}</td>
                    <td className="py-2 pr-3 text-right text-emerald-600">{log.contacts_created}</td>
                    <td className="py-2 pr-3 text-right" style={{ color: 'var(--color-primary)' }}>{log.contacts_updated}</td>
                    <td className="py-2 pr-3 text-right text-red-500">{log.contacts_failed}</td>
                    <td className="py-2"><StatusChip status={log.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

interface NewConnectionModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function NewConnectionModal({ open, onClose, onSaved }: NewConnectionModalProps) {
  const { t } = useTranslation();
  const api = useApi();

  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState<SyncProvider | null>(null);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [instanceUrl, setInstanceUrl] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [csvUrl, setCsvUrl] = useState('');
  const [authHeader, setAuthHeader] = useState('');
  const [mappings, setMappings] = useState<FieldMapping[]>([]);
  const [schedule, setSchedule] = useState<'manual' | 'hourly' | 'daily' | 'weekly'>('manual');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setStep(1); setProvider(null); setName(''); setApiKey('');
      setInstanceUrl(''); setAccessToken(''); setCsvUrl(''); setAuthHeader('');
      setMappings([]); setSchedule('manual'); setSaving(false); setCopied(false);
    }
  }, [open]);

  useEffect(() => {
    if (provider) setMappings(DEFAULT_MAPPINGS[provider]);
  }, [provider]);

  function addMapping() {
    setMappings((prev) => [...prev, { source: '', dest: 'email' }]);
  }
  function removeMapping(idx: number) {
    setMappings((prev) => prev.filter((_, i) => i !== idx));
  }
  function updateMapping(idx: number, patch: Partial<FieldMapping>) {
    setMappings((prev) => prev.map((m, i) => i === idx ? { ...m, ...patch } : m));
  }

  async function handleSave() {
    if (!provider || !name.trim()) return;
    setSaving(true);
    try {
      const config: Record<string, string> = {};
      if (provider === 'hubspot') config.api_key = apiKey;
      if (provider === 'salesforce') { config.instance_url = instanceUrl; config.access_token = accessToken; }
      if (provider === 'csv_url') { config.url = csvUrl; if (authHeader) config.auth_header = authHeader; }

      await api.createSyncConfig({
        name: name.trim(),
        provider,
        config,
        field_mappings: mappings,
        sync_schedule: schedule,
        is_active: true,
      });
      onSaved();
      onClose();
    } catch (err) {
      console.error('[NewConnectionModal] save error', err);
    } finally {
      setSaving(false);
    }
  }

  async function copyWebhookUrl() {
    const url = `${window.location.origin}/api/contacts/sync/webhook/new`;
    await navigator.clipboard.writeText(url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const providers: SyncProvider[] = ['hubspot', 'salesforce', 'csv_url', 'webhook'];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="w-full max-w-lg p-0 overflow-hidden rounded-2xl"
        style={{
          background: 'rgba(255,255,255,0.96)',
          backdropFilter: 'blur(32px) saturate(180%)',
          border: '1px solid rgba(255,255,255,0.7)',
          boxShadow: '0 40px 80px -20px rgba(0,0,0,0.22)',
        }}
      >
        <div
          className="px-7 pt-7 pb-5"
          style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 6%, transparent), color-mix(in srgb, var(--color-tertiary) 4%, transparent))', borderBottom: '1px solid color-mix(in srgb, var(--color-primary) 10%, transparent)' }}
        >
          <DialogHeader>
            <DialogTitle className="text-xl font-extrabold font-headline" style={gradientTextStyle}>
              {t('syncConnections.newConnection')}
            </DialogTitle>
          </DialogHeader>
          <div className="flex gap-2 mt-3">
            {[t('syncConnections.modal.stepProvider'), t('syncConnections.modal.stepConfig'), t('syncConnections.modal.stepMappings'), t('syncConnections.modal.stepSchedule')].map((label, i) => (
              <div key={i} className="flex items-center gap-1">
                <div
                  className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
                  style={{
                    background: step > i + 1 ? '#059669' : step === i + 1 ? 'var(--color-primary)' : 'rgba(100,116,139,0.2)',
                    color: step >= i + 1 ? '#fff' : '#94a3b8',
                  }}
                >
                  {step > i + 1 ? '✓' : i + 1}
                </div>
                <span className="text-[10px] text-on-surface-variant hidden sm:block">{label}</span>
                {i < 3 && <div className="w-4 h-px mx-1" style={{ background: 'color-mix(in srgb, var(--color-primary) 20%, transparent)' }} />}
              </div>
            ))}
          </div>
        </div>

        <div className="px-7 py-6 min-h-[240px]">
          {step === 1 && (
            <div className="grid grid-cols-2 gap-3">
              {providers.map((p) => {
                const meta = PROVIDER_META[p];
                return (
                  <button
                    key={p}
                    onClick={() => setProvider(p)}
                    className="flex items-center gap-3 p-4 rounded-xl text-left transition-all"
                    style={{
                      background: provider === p ? 'color-mix(in srgb, var(--color-primary) 8%, transparent)' : 'rgba(255,255,255,0.7)',
                      border: provider === p ? '2px solid var(--color-primary)' : '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)',
                      boxShadow: provider === p ? '0 4px 12px color-mix(in srgb, var(--color-primary) 15%, transparent)' : 'none',
                    }}
                  >
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center text-xs font-black shrink-0" style={{ background: meta.bg, color: meta.text }}>
                      {meta.initials}
                    </div>
                    <div>
                      <p className="text-sm font-bold text-on-surface">{t(`syncConnections.providers.${p}`)}</p>
                      <p className="text-[11px] text-on-surface-variant mt-0.5 leading-snug">{t(`syncConnections.providerDescriptions.${p}`)}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {step === 2 && provider && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">{t('syncConnections.modal.configName')}</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('syncConnections.modal.configNamePlaceholder')} className="rounded-xl" style={{ background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }} />
              </div>

              {provider === 'hubspot' && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">{t('syncConnections.modal.apiKey')}</Label>
                  <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="rounded-xl" style={{ background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }} />
                </div>
              )}

              {provider === 'salesforce' && (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">{t('syncConnections.modal.instanceUrl')}</Label>
                    <Input value={instanceUrl} onChange={(e) => setInstanceUrl(e.target.value)} placeholder="https://yourorg.salesforce.com" className="rounded-xl" style={{ background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">{t('syncConnections.modal.accessToken')}</Label>
                    <Input type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} className="rounded-xl" style={{ background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }} />
                  </div>
                </>
              )}

              {provider === 'csv_url' && (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">{t('syncConnections.modal.csvUrl')}</Label>
                    <Input value={csvUrl} onChange={(e) => setCsvUrl(e.target.value)} placeholder="https://..." className="rounded-xl" style={{ background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">{t('syncConnections.modal.authHeader')}</Label>
                    <Input value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} placeholder="Bearer token..." className="rounded-xl" style={{ background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }} />
                  </div>
                </>
              )}

              {provider === 'webhook' && (
                <div className="space-y-2">
                  <Label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">{t('syncConnections.modal.webhookUrl')}</Label>
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      value={`${window.location.origin}/api/contacts/sync/webhook/new`}
                      className="flex-1 rounded-xl text-xs font-mono"
                      style={{ background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }}
                    />
                    <Button variant="outline" size="sm" onClick={copyWebhookUrl} className="rounded-xl shrink-0">
                      <Icon name={copied ? 'check' : 'content_copy'} size={14} />
                      <span className="ml-1 text-xs">{copied ? t('syncConnections.modal.copied') : t('syncConnections.modal.copy')}</span>
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 3 && provider && (
            <div className="space-y-3">
              <p className="text-xs text-on-surface-variant">{t('syncConnections.modal.fieldMappings', { provider: PROVIDER_META[provider].label })}</p>
              {mappings.map((m, idx) => (
                <div key={idx} className="flex gap-2 items-center">
                  <Input
                    value={m.source}
                    onChange={(e) => updateMapping(idx, { source: e.target.value })}
                    placeholder={t('syncConnections.modal.sourceField')}
                    className="flex-1 text-xs rounded-lg h-8"
                    style={{ background: 'rgba(255,255,255,0.8)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }}
                  />
                  <Icon name="arrow_forward" size={14} className="text-on-surface-variant shrink-0" />
                  <Select value={m.dest} onValueChange={(v) => updateMapping(idx, { dest: v })}>
                    <SelectTrigger className="flex-1 text-xs rounded-lg h-8" style={{ background: 'rgba(255,255,255,0.8)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DEST_FIELD_OPTIONS.map((opt) => (
                        <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <button onClick={() => removeMapping(idx)} className="text-on-surface-variant hover:text-red-500 transition-colors shrink-0">
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={addMapping}
                className="text-xs w-full rounded-lg"
                style={{ border: '1px dashed color-mix(in srgb, var(--color-primary) 30%, transparent)', color: 'var(--color-primary)' }}
              >
                <Icon name="add" size={14} className="mr-1" />
                {t('syncConnections.modal.addMapping')}
              </Button>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-3">
              <Label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">{t('syncConnections.schedule.label')}</Label>
              {(['manual', 'hourly', 'daily', 'weekly'] as const).map((opt) => (
                <button
                  key={opt}
                  onClick={() => setSchedule(opt)}
                  className="w-full flex items-center gap-3 p-3.5 rounded-xl text-left transition-all"
                  style={{
                    background: schedule === opt ? 'color-mix(in srgb, var(--color-primary) 8%, transparent)' : 'rgba(255,255,255,0.7)',
                    border: schedule === opt ? '2px solid var(--color-primary)' : '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)',
                  }}
                >
                  <div
                    className="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0"
                    style={{ borderColor: schedule === opt ? 'var(--color-primary)' : '#94a3b8' }}
                  >
                    {schedule === opt && <div className="w-2 h-2 rounded-full" style={{ background: 'var(--color-primary)' }} />}
                  </div>
                  <span className="text-sm text-on-surface font-medium">{t(`syncConnections.schedule.${opt}`)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="flex gap-3 px-7 pb-7">
          {step > 1 && (
            <Button variant="secondary" className="rounded-xl" onClick={() => setStep((s) => s - 1)}>
              <Icon name="arrow_back" size={14} className="mr-1" />
              {t('syncConnections.modal.back')}
            </Button>
          )}
          <div className="flex-1" />
          {step < 4 ? (
            <Button
              className="rounded-xl font-bold text-white px-5"
              style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
              disabled={step === 1 && !provider}
              onClick={() => setStep((s) => s + 1)}
            >
              {t('syncConnections.modal.next')}
              <Icon name="arrow_forward" size={14} className="ml-1" />
            </Button>
          ) : (
            <Button
              className="rounded-xl font-bold text-white px-5 flex items-center gap-2"
              style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
              disabled={!name.trim() || saving}
              onClick={handleSave}
            >
              {saving ? (
                <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin border-white" />
              ) : (
                <>{t('syncConnections.modal.save')}</>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ConfigCardProps {
  config: SyncConfig;
  onDeleted: () => void;
  onUpdated: () => void;
  onViewLogs: (config: SyncConfig) => void;
}

function ConfigCard({ config, onDeleted, onUpdated: _onUpdated, onViewLogs }: ConfigCardProps) {
  const { t } = useTranslation();
  const api = useApi();
  const [syncing, setSyncing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSync() {
    setSyncing(true);
    try {
      await api.runSync(config.id);
    } catch (err) {
      console.error('[ConfigCard] runSync error', err);
    } finally {
      setSyncing(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.deleteSyncConfig(config.id);
      onDeleted();
      setConfirmDelete(false);
    } catch (err) {
      console.error('[ConfigCard] delete error', err);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <motion.div variants={rise}>
        <Card style={glassCard}>
          <div className="p-5 flex items-center gap-4">
            <ProviderBadge provider={config.provider} />

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-on-surface text-sm">{config.name}</span>
                <Badge
                  className="text-[10px] px-1.5 py-0.5 rounded-full font-medium capitalize"
                  style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)', color: 'var(--color-primary)' }}
                >
                  {t(`syncConnections.providers.${config.provider}`)}
                </Badge>
                {config.last_sync_status && <StatusChip status={config.last_sync_status} />}
              </div>
              <p className="text-xs text-on-surface-variant mt-0.5">
                {config.last_synced_at
                  ? t('syncConnections.lastSynced', { time: formatRelativeTime(config.last_synced_at) })
                  : t('syncConnections.neverSynced')}
              </p>
              <p className="text-[10px] text-on-surface-variant mt-0.5 capitalize">
                {t(`syncConnections.schedule.${config.sync_schedule ?? 'manual'}`)}
              </p>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <Button size="sm" variant="outline" className="text-xs rounded-lg h-7 px-2" onClick={handleSync} disabled={syncing}>
                {syncing ? (
                  <div className="w-3 h-3 rounded-full border-2 border-t-transparent animate-spin mr-1" style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 30%, transparent)', borderTopColor: 'var(--color-primary)' }} />
                ) : (
                  <Icon name="sync" size={12} className="mr-1" />
                )}
                {syncing ? t('syncConnections.syncing') : t('syncConnections.syncNow')}
              </Button>
              <Button size="sm" variant="ghost" className="text-xs rounded-lg h-7 px-2" onClick={() => onViewLogs(config)}>
                <Icon name="history" size={12} className="mr-1" />
                {t('syncConnections.viewLogs')}
              </Button>
              <Button size="sm" variant="ghost" className="rounded-lg h-7 w-7 p-0 text-red-500 hover:text-red-600" onClick={() => setConfirmDelete(true)}>
                <Icon name="delete" size={12} />
              </Button>
            </div>
          </div>
        </Card>
      </motion.div>

      <Dialog open={confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(false); }}>
        <DialogContent className="w-full max-w-md p-0 overflow-hidden rounded-2xl" style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(32px)', border: '1px solid rgba(255,255,255,0.7)', boxShadow: '0 40px 80px -20px rgba(0,0,0,0.22)' }}>
          <div className="px-7 pt-7 pb-5" style={{ borderBottom: '1px solid rgba(220,38,38,0.1)', background: 'rgba(220,38,38,0.04)' }}>
            <DialogHeader>
              <DialogTitle className="text-lg font-extrabold font-headline text-red-600">Delete Connection</DialogTitle>
            </DialogHeader>
          </div>
          <div className="px-7 py-5">
            <p className="text-sm text-on-surface-variant">{t('syncConnections.deleteConfirm', { name: config.name })}</p>
          </div>
          <DialogFooter className="flex gap-3 px-7 pb-7">
            <Button variant="secondary" className="flex-1 rounded-xl" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="destructive" className="flex-1 rounded-xl flex items-center justify-center gap-2" disabled={deleting} onClick={handleDelete}>
              {deleting ? <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin border-white" /> : <><Icon name="delete" size={14} className="mr-1" />Delete</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function SettingsConnectionsPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('syncConnections.title'), t('syncConnections.subtitle'));
  const api = useApi();

  const [configs, setConfigs] = useState<SyncConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewModal, setShowNewModal] = useState(false);
  const [logsConfig, setLogsConfig] = useState<SyncConfig | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listSyncConfigs();
      setConfigs(list);
    } catch (err) {
      console.error('[SettingsConnectionsPage] load error', err);
      setConfigs([]);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const providers: SyncProvider[] = ['hubspot', 'salesforce', 'csv_url', 'webhook'];

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: t('nav.settings'), path: ROUTES.SETTINGS },
          { label: t('syncConnections.title') },
        ]}
        title={t('syncConnections.title')}
        subtitle={t('syncConnections.subtitle')}
        actions={
          <Button
            onClick={() => setShowNewModal(true)}
            className="font-bold text-sm text-white rounded-xl px-5 py-2.5 active:scale-95"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
          >
            <Icon name="add" size={16} className="mr-1.5" />
            {t('syncConnections.newConnection')}
          </Button>
        }
      />

      <motion.div
        className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        {providers.map((p) => {
          const meta = PROVIDER_META[p];
          return (
            <button
              key={p}
              onClick={() => setShowNewModal(true)}
              className="flex flex-col items-center gap-3 p-5 rounded-2xl text-center transition-all hover:shadow-lg active:scale-95"
              style={{
                background: 'rgba(255,255,255,0.72)',
                backdropFilter: 'blur(20px)',
                border: '1px solid rgba(255,255,255,0.6)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.04)',
              }}
            >
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-sm font-black" style={{ background: meta.bg, color: meta.text }}>
                {meta.initials}
              </div>
              <div>
                <p className="text-sm font-bold text-on-surface">{t(`syncConnections.providers.${p}`)}</p>
                <p className="text-[11px] text-on-surface-variant mt-0.5 leading-snug">{t(`syncConnections.providerDescriptions.${p}`)}</p>
              </div>
            </button>
          );
        })}
      </motion.div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-bold text-on-surface">Configured Connections</h2>
        <span className="text-sm text-on-surface-variant">{configs.length} connection{configs.length !== 1 ? 's' : ''}</span>
      </div>

      {loading && (
        <div className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Card key={i} style={{ ...glassCard, padding: '1.25rem' }}>
              <div className="flex items-center gap-4">
                <div className="skeleton w-9 h-9 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-4 rounded w-1/4" />
                  <div className="skeleton h-3 rounded w-1/3" />
                </div>
                <div className="skeleton h-7 rounded-lg w-20" />
              </div>
            </Card>
          ))}
        </div>
      )}

      {!loading && configs.length > 0 && (
        <motion.div className="flex flex-col gap-3" variants={stagger} initial="hidden" animate="visible">
          {configs.map((config) => (
            <ConfigCard
              key={config.id}
              config={config}
              onDeleted={load}
              onUpdated={load}
              onViewLogs={setLogsConfig}
            />
          ))}
        </motion.div>
      )}

      {!loading && configs.length === 0 && (
        <motion.div
          className="text-center py-16"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 12%, transparent), color-mix(in srgb, var(--color-tertiary) 10%, transparent))', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }}
          >
            <Icon name="cable" size={28} style={{ color: 'var(--color-primary)' }} />
          </div>
          <h3 className="text-xl font-black mb-2 font-headline" style={gradientTextStyle}>{t('syncConnections.noConnections')}</h3>
          <p className="text-sm text-on-surface-variant max-w-sm mx-auto mb-6">{t('syncConnections.noConnectionsDescription')}</p>
          <Button
            onClick={() => setShowNewModal(true)}
            className="px-6 py-3 font-bold text-sm text-white rounded-xl active:scale-95"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
          >
            <Icon name="add" size={16} className="mr-1.5" />
            {t('syncConnections.newConnection')}
          </Button>
        </motion.div>
      )}

      <NewConnectionModal open={showNewModal} onClose={() => setShowNewModal(false)} onSaved={load} />
      <LogsSheet config={logsConfig} onClose={() => setLogsConfig(null)} />
    </div>
  );
}
