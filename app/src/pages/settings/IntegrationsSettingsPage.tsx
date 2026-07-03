import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useApi } from '../../hooks/useApi';
import { useTranslation } from '../../lib/i18n';
import { usePermissions } from '../../lib/permissions';
import { ROUTES } from '../../constants/routes';
import { PageHeader } from '../../components/PageHeader';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConnectorModal } from '../../components/integrations/ConnectorModal';
import { ConnectorBadge, CONNECTOR_META } from '../../components/integrations/ConnectorBadge';
import { CATEGORY_CONNECTORS } from '../../components/integrations/connectorFields';
import { ConnectorTestError } from '../../lib/api';
import type { WorkflowConnectorEntry, WorkflowConnectorName } from '../../types';

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

export function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// Client-side-only "connection error" signal — the vault has no server-persisted
// health state (per Rohan's spec §1.1), so this is session-scoped: it's set the
// moment a Test Connection in the modal fails, and cleared on the next successful
// load/save. It intentionally does not survive a page reload.
export type ErrorFlags = Record<string, boolean>;

interface CategorySectionProps {
  title: string;
  subtitle: string;
  icon: string;
  children: React.ReactNode;
}

// Genuinely reusable wrapper — per Rohan's spec §1/§6, a future "Data Sources"
// (Prism) section is purely additive markup: a second <CategorySection> appended
// after this one, no restructuring of the page shell.
export function CategorySection({ title, subtitle, icon, children }: CategorySectionProps) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-1">
        <Icon name={icon} size={18} className="text-on-surface-variant" />
        <h2 className="text-base font-bold text-on-surface">{title}</h2>
      </div>
      <p className="text-sm text-on-surface-variant mb-4">{subtitle}</p>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {children}
      </div>
    </div>
  );
}

interface IntegrationCardProps {
  connector: WorkflowConnectorName;
  entry: WorkflowConnectorEntry | undefined;
  hasError: boolean;
  onOpen: (connector: WorkflowConnectorName) => void;
}

export function IntegrationCard({ connector, entry, hasError, onOpen }: IntegrationCardProps) {
  const { t } = useTranslation();
  const meta = CONNECTOR_META[connector];
  const status = entry?.status ?? 'none';

  // Three-state model (Rohan's spec §1.1), with a 4th client-only "error" overlay
  // that takes priority when a Test Connection just failed in this session.
  const dotColor = hasError ? '#dc2626' : status === 'org' ? '#059669' : status === 'shared' ? '#059669' : 'rgba(100,116,139,0.4)';
  const statusLabel = hasError
    ? t('integrationsSettings.status.connectionError')
    : status === 'org' || status === 'shared'
      ? t('integrationsSettings.status.connected')
      : t('integrationsSettings.status.notConnected');

  const actionLabel = hasError
    ? t('integrationsSettings.actions.reconnect')
    : status === 'org'
      ? t('integrationsSettings.actions.edit')
      : t('integrationsSettings.actions.connect');

  const isConnectedOrg = status === 'org';
  const isShared = status === 'shared';

  return (
    <motion.div variants={rise}>
      <Card style={glassCard} className="p-5 flex flex-col gap-3" data-testid={`integration-card-${connector}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-3 min-w-0">
            <ConnectorBadge connector={connector} />
            <div className="min-w-0">
              <p className="font-bold text-on-surface text-sm">{meta.label}</p>
              <p className="text-xs text-on-surface-variant mt-0.5 leading-snug">{meta.description}</p>
            </div>
          </div>
          <span className="flex items-center gap-1.5 shrink-0 mt-1">
            <span className="w-2 h-2 rounded-full" style={{ background: dotColor }} />
            <span className="text-[11px] font-semibold text-on-surface-variant whitespace-nowrap">{statusLabel}</span>
          </span>
        </div>

        {isShared && !hasError && (
          <p className="text-[11px] text-on-surface-variant">{t('integrationsSettings.status.sharedDefault')}</p>
        )}

        {isConnectedOrg && entry?.updatedAt && !hasError && (
          <p className="text-[11px] text-on-surface-variant">
            {t('integrationsSettings.status.configuredAgo', { time: formatRelativeTime(entry.updatedAt) })}
          </p>
        )}

        <div className="flex justify-end mt-1">
          <Button size="sm" variant="outline" className="rounded-lg text-xs" onClick={() => onOpen(connector)}>
            {actionLabel}
            <Icon name="chevron_right" size={14} className="ml-1" />
          </Button>
        </div>
      </Card>
    </motion.div>
  );
}

export function IntegrationsSettingsPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('integrationsSettings.title'), t('integrationsSettings.subtitle'));
  const { isAdmin } = usePermissions();
  const api = useApi();

  const [entries, setEntries] = useState<WorkflowConnectorEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [openConnector, setOpenConnector] = useState<WorkflowConnectorName | null>(null);
  const [errorFlags, setErrorFlags] = useState<ErrorFlags>({});
  const [vaultUnconfigured, setVaultUnconfigured] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listWorkflowCredentials();
      setEntries(list);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const key = 'integrations_settings_banner_dismissed';
    setBannerDismissed(window.localStorage.getItem(key) === '1');
  }, []);

  function dismissBanner() {
    window.localStorage.setItem('integrations_settings_banner_dismissed', '1');
    setBannerDismissed(true);
  }

  const entryByConnector = useMemo(() => {
    const map = new Map<string, WorkflowConnectorEntry>();
    entries.forEach((e) => map.set(e.connector, e));
    return map;
  }, [entries]);

  const noneConnected = CATEGORY_CONNECTORS.every((c) => (entryByConnector.get(c)?.status ?? 'none') === 'none');

  function handleSaved(connector: WorkflowConnectorName) {
    setErrorFlags((prev) => ({ ...prev, [connector]: false }));
    setVaultUnconfigured(false);
    load();
  }

  function handleVaultUnconfigured() {
    setVaultUnconfigured(true);
  }

  function handleTestOutcome(connector: WorkflowConnectorName, success: boolean) {
    setErrorFlags((prev) => ({ ...prev, [connector]: !success }));
  }

  function handleDisconnected(connector: WorkflowConnectorName) {
    setErrorFlags((prev) => ({ ...prev, [connector]: false }));
    load();
  }

  if (!isAdmin) {
    return (
      <div className="max-w-7xl mx-auto w-full">
        <PageHeader title={t('integrationsSettings.title')} />
        <div className="rounded-xl border border-border p-8 text-center text-on-surface-variant">
          <Icon name="lock" size={32} className="mx-auto mb-3 opacity-50" />
          {t('integrationsSettings.accessDenied')}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: t('nav.workflows'), path: ROUTES.WORKFLOWS },
          { label: t('integrationsSettings.title') },
        ]}
        title={t('integrationsSettings.title')}
        subtitle={t('integrationsSettings.subtitle')}
      />

      {vaultUnconfigured && (
        <div
          className="flex items-center gap-2 px-4 py-3 mb-6 rounded-xl text-sm font-semibold"
          style={{ background: 'rgba(217,119,6,0.1)', color: '#d97706' }}
          data-testid="vault-unconfigured-banner"
        >
          <Icon name="warning" size={16} />
          {t('integrationsSettings.emptyState.vaultUnconfigured')}
        </div>
      )}

      {!vaultUnconfigured && !loading && noneConnected && !bannerDismissed && (
        <div
          className="flex items-center gap-3 px-4 py-3 mb-6 rounded-xl text-sm"
          style={{ background: 'color-mix(in srgb, var(--color-primary) 6%, transparent)', color: 'var(--color-primary)' }}
          data-testid="empty-state-banner"
        >
          <Icon name="info" size={16} className="shrink-0" />
          <span className="flex-1">{t('integrationsSettings.emptyState.banner')}</span>
          <button onClick={dismissBanner} aria-label={t('integrationsSettings.actions.cancel')} className="shrink-0 opacity-60 hover:opacity-100">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-8">
          {CATEGORY_CONNECTORS.map((c) => (
            <Card key={c} style={{ ...glassCard, padding: '1.25rem' }}>
              <div className="flex items-center gap-3">
                <div className="skeleton w-9 h-9 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-4 rounded w-2/3" />
                  <div className="skeleton h-3 rounded w-1/2" />
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <motion.div variants={stagger} initial="hidden" animate="visible">
          <CategorySection
            title={t('integrationsSettings.sections.workflowActions.title')}
            subtitle={t('integrationsSettings.sections.workflowActions.subtitle')}
            icon="bolt"
          >
            {CATEGORY_CONNECTORS.map((connector) => (
              <IntegrationCard
                key={connector}
                connector={connector}
                entry={entryByConnector.get(connector)}
                hasError={Boolean(errorFlags[connector])}
                onOpen={setOpenConnector}
              />
            ))}
          </CategorySection>
        </motion.div>
      )}

      <ConnectorModal
        connector={openConnector}
        entry={openConnector ? entryByConnector.get(openConnector) : undefined}
        open={openConnector != null}
        onClose={() => setOpenConnector(null)}
        onSaved={handleSaved}
        onVaultUnconfigured={handleVaultUnconfigured}
        onTestOutcome={handleTestOutcome}
        onDisconnected={handleDisconnected}
      />
    </div>
  );
}

export { ConnectorTestError };
