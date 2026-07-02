import { useState, useEffect } from 'react';
import { useTranslation } from '../../lib/i18n';
import { useApi } from '../../hooks/useApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Icon } from '../Icon';
import { ConnectorBadge, CONNECTOR_META } from './ConnectorBadge';
import { CONNECTOR_FIELDS, validateField, stripTrailingSlash } from './connectorFields';
import { ConnectorTestError } from '../../lib/api';
import type { WorkflowConnectorEntry, WorkflowConnectorName } from '../../types';

const MASK = '••••••••';

type TestPhase = 'idle' | 'testing' | 'success' | 'failure';

interface ConnectorModalProps {
  connector: WorkflowConnectorName | null;
  entry: WorkflowConnectorEntry | undefined;
  open: boolean;
  onClose: () => void;
  onSaved: (connector: WorkflowConnectorName) => void;
  onVaultUnconfigured: () => void;
  onTestOutcome: (connector: WorkflowConnectorName, success: boolean) => void;
  onDisconnected: (connector: WorkflowConnectorName) => void;
}

export function ConnectorModal({
  connector, entry, open, onClose, onSaved, onVaultUnconfigured, onTestOutcome, onDisconnected,
}: ConnectorModalProps) {
  const { t } = useTranslation();
  const api = useApi();

  const isConnected = (entry?.status ?? 'none') === 'org' || (entry?.status ?? 'none') === 'shared';
  const fields = connector ? CONNECTOR_FIELDS[connector] : [];

  // Values start blank on every open — the vault never returns decrypted secrets
  // (per Rohan's spec §3), so there is nothing to prefill even for non-secret
  // fields. Secret fields on an already-configured connector render a locked
  // "••••••••" placeholder instead (see `replacing` below).
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  // Which secret fields have been "unlocked" via Replace — starts empty (locked)
  // for every secret field on an already-connected connector, and effectively
  // moot (all fields are always editable) for a fresh Connect flow.
  const [replacing, setReplacing] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testPhase, setTestPhase] = useState<TestPhase>('idle');
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (open) {
      setValues({});
      setTouched({});
      setReplacing({});
      setSaveError(null);
      setTestPhase('idle');
      setTestMessage(null);
      setConfirmDisconnect(false);
    }
  }, [open, connector]);

  if (!connector) return null;

  // Narrowed, stable reference — TS can't retain the `!connector` narrowing of
  // the prop inside function declarations defined below (closures over a
  // parameter aren't narrowed the same way locals are), so callbacks close
  // over this const instead of the raw `connector` prop.
  const activeConnector: WorkflowConnectorName = connector;
  const meta = CONNECTOR_META[activeConnector];
  const isSlack = activeConnector === 'slack';

  // A secret field only renders as an editable input if: the connector isn't
  // connected yet (fresh Connect flow — nothing to lock), or the user clicked
  // Replace on it. Non-secret fields (and Slack's single non-secret URL field)
  // are always editable.
  function isFieldEditable(key: string, secret?: boolean): boolean {
    if (!secret) return true;
    if (!isConnected) return true;
    return Boolean(replacing[key]);
  }

  function fieldValue(key: string): string {
    return values[key] ?? '';
  }

  function setFieldValue(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
    // Any edit invalidates a stale test result.
    if (testPhase !== 'idle' && testPhase !== 'testing') { setTestPhase('idle'); setTestMessage(null); }
  }

  function handleBlur(key: string, uppercaseOnBlur?: boolean) {
    setTouched((prev) => ({ ...prev, [key]: true }));
    if (uppercaseOnBlur) {
      setValues((prev) => ({ ...prev, [key]: (prev[key] ?? '').toUpperCase() }));
    }
    if (key === 'baseUrl' || key === 'instanceUrl') {
      setValues((prev) => ({ ...prev, [key]: stripTrailingSlash(prev[key] ?? '') }));
    }
  }

  function fieldError(key: string): string | null {
    if (!touched[key]) return null;
    if (!isFieldEditable(key, fields.find((f) => f.key === key)?.secret)) return null;
    return validateField(activeConnector, key, fieldValue(key));
  }

  // Only fields that are currently editable participate in the validity gate —
  // a locked "••••••••" placeholder is implicitly valid (it represents an
  // already-saved value the backend already has).
  const editableFields = fields.filter((f) => isFieldEditable(f.key, f.secret));
  const editableValues: Record<string, string> = {};
  editableFields.forEach((f) => { editableValues[f.key] = fieldValue(f.key); });
  const formValid = editableFields.length > 0 && editableFields.every((f) => !validateField(activeConnector, f.key, editableValues[f.key] ?? ''));

  function buildPayload(): Record<string, string> {
    // Only send fields the user actually changed/entered — the backend merges
    // onto the existing saved row (Nina's §0 fix), so a Replace-only-the-token
    // save must NOT resend locked-placeholder fields as empty strings.
    const payload: Record<string, string> = {};
    editableFields.forEach((f) => { payload[f.key] = fieldValue(f.key).trim(); });
    return payload;
  }

  async function handleTest() {
    setTestPhase('testing');
    setTestMessage(null);
    try {
      const payload = buildPayload();
      const result = await api.testWorkflowCredentials(activeConnector, Object.keys(payload).length ? payload : undefined);
      if (result.success) {
        setTestPhase('success');
        setTestMessage(isSlack ? t('integrationsSettings.test.slackSent') : (result.message || t('integrationsSettings.test.verified')));
        onTestOutcome(activeConnector, true);
      } else {
        setTestPhase('failure');
        setTestMessage(result.message || t('integrationsSettings.test.genericFailure'));
        onTestOutcome(activeConnector, false);
      }
    } catch (err) {
      setTestPhase('failure');
      if (err instanceof ConnectorTestError && err.rateLimited) {
        setTestMessage(t('integrationsSettings.test.rateLimited'));
      } else {
        setTestMessage(err instanceof Error ? err.message : t('integrationsSettings.test.genericFailure'));
      }
      onTestOutcome(activeConnector, false);
    } finally {
      // Revert the button label after ~2.5s, per spec — result banner stays.
      setTimeout(() => setTestPhase((p) => (p === 'testing' ? p : 'idle')), 2500);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const payload = buildPayload();
      if (isSlack) {
        // Slack's field maps to notification_channels via the same unified
        // /api/workflow-credentials/slack surface per Nina's final API —
        // write path still goes through setWorkflowCredentials('slack', ...).
        await api.setWorkflowCredentials('slack', payload);
      } else {
        await api.setWorkflowCredentials(activeConnector, payload);
      }
      onSaved(activeConnector);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('vault is not configured') || message.includes('503')) {
        onVaultUnconfigured();
      }
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await api.deleteWorkflowCredentials(activeConnector);
      onDisconnected(activeConnector);
      setConfirmDisconnect(false);
      onClose();
    } catch {
      /* ignore — surfaced via card staying in its current state */
    } finally {
      setDisconnecting(false);
    }
  }

  const headingKey = isConnected
    ? (entry?.status === 'org' ? 'integrationsSettings.modal.editHeading' : 'integrationsSettings.modal.connectHeading')
    : 'integrationsSettings.modal.connectHeading';

  return (
    <>
      <Dialog open={open && !confirmDisconnect} onOpenChange={(o) => { if (!o) onClose(); }}>
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
            className="px-7 pt-7 pb-5 flex items-center gap-3"
            style={{ background: 'linear-gradient(135deg, rgba(42,75,217,0.06), rgba(131,41,200,0.04))', borderBottom: '1px solid rgba(42,75,217,0.1)' }}
          >
            <ConnectorBadge connector={activeConnector} />
            <div>
              <DialogHeader className="p-0">
                <DialogTitle className="text-lg font-extrabold font-headline text-on-surface">
                  {t(headingKey, { connector: meta.label })}
                </DialogTitle>
              </DialogHeader>
              <p className="text-xs text-on-surface-variant mt-0.5">{meta.description}</p>
            </div>
          </div>

          <div className="px-7 py-6 space-y-4">
            {isSlack && (
              <p className="text-xs text-on-surface-variant">{t('integrationsSettings.helpText.slackHowTo')}</p>
            )}

            {fields.map((field) => {
              const editable = isFieldEditable(field.key, field.secret);
              const error = fieldError(field.key);
              const inputType = field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : field.type === 'email' ? 'email' : 'text';
              return (
                <div className="space-y-1.5" key={field.key}>
                  <Label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">
                    {t(field.labelKey)}
                  </Label>
                  {editable ? (
                    <>
                      <div className="flex gap-2 items-start">
                        <Input
                          type={inputType}
                          value={fieldValue(field.key)}
                          onChange={(e) => setFieldValue(field.key, e.target.value)}
                          onBlur={() => handleBlur(field.key, field.uppercaseOnBlur)}
                          placeholder={field.placeholder}
                          disabled={testPhase === 'testing' || saving}
                          className="rounded-xl flex-1"
                          style={{ background: 'rgba(42,75,217,0.04)', border: '1px solid rgba(42,75,217,0.15)' }}
                          data-testid={`field-${field.key}`}
                        />
                        {field.secret && isConnected && replacing[field.key] && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-xs shrink-0"
                            onClick={() => {
                              setReplacing((prev) => ({ ...prev, [field.key]: false }));
                              setValues((prev) => ({ ...prev, [field.key]: '' }));
                              setTouched((prev) => ({ ...prev, [field.key]: false }));
                            }}
                          >
                            {t('integrationsSettings.masking.cancelReplace')}
                          </Button>
                        )}
                      </div>
                      {error && <p className="text-xs text-red-500">{t(error)}</p>}
                      {field.helpTextKey && !error && (
                        <p className="text-[11px] text-on-surface-variant">{t(field.helpTextKey)}</p>
                      )}
                      {field.key === 'subdomain' && fieldValue('subdomain') && !error && (
                        <p className="text-[11px] text-on-surface-variant">
                          {t('integrationsSettings.helpText.zendeskSubdomainPreview', { subdomain: fieldValue('subdomain') })}
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div
                        className="flex-1 flex items-center gap-2 rounded-xl px-3 h-10 text-sm text-on-surface-variant"
                        style={{ background: 'rgba(100,116,139,0.06)', border: '1px solid rgba(100,116,139,0.15)' }}
                        data-testid={`field-locked-${field.key}`}
                      >
                        <Icon name="lock" size={14} className="shrink-0 opacity-60" />
                        <span className="font-mono tracking-widest">{MASK}</span>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="text-xs shrink-0 rounded-lg"
                        onClick={() => setReplacing((prev) => ({ ...prev, [field.key]: true }))}
                      >
                        {t('integrationsSettings.masking.replace')}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}

            {testPhase === 'success' && testMessage && (
              <div className="rounded-xl px-4 py-2.5 text-xs font-semibold" style={{ background: 'rgba(5,150,105,0.08)', color: '#059669' }} data-testid="test-success-banner">
                {testMessage}
              </div>
            )}
            {testPhase === 'failure' && testMessage && (
              <div className="rounded-xl px-4 py-2.5 text-xs font-semibold" style={{ background: 'rgba(220,38,38,0.08)', color: '#dc2626' }} data-testid="test-failure-banner">
                {testMessage}
              </div>
            )}
            {saveError && (
              <div className="rounded-xl px-4 py-2.5 text-xs font-semibold" style={{ background: 'rgba(220,38,38,0.08)', color: '#dc2626' }} data-testid="save-error-banner">
                {saveError}
              </div>
            )}

            {isConnected && (
              <button
                type="button"
                className="text-xs font-semibold text-red-600 hover:text-red-700 transition-colors"
                onClick={() => setConfirmDisconnect(true)}
                data-testid="open-disconnect-confirm"
              >
                {t('integrationsSettings.actions.disconnect', { connector: meta.label })}
              </button>
            )}
          </div>

          <DialogFooter className="flex gap-3 px-7 pb-7">
            <Button
              type="button"
              variant="outline"
              className="rounded-xl text-xs"
              disabled={!formValid || testPhase === 'testing' || saving}
              onClick={handleTest}
              data-testid="test-connection-button"
            >
              {testPhase === 'testing' ? (
                <span className="flex items-center gap-1.5">
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'rgba(42,75,217,0.3)', borderTopColor: 'var(--color-primary)' }} />
                  {t('integrationsSettings.actions.testing')}
                </span>
              ) : testPhase === 'success' ? (
                <span className="flex items-center gap-1.5 text-emerald-600">
                  <Icon name="check_circle" size={14} />
                  {t('integrationsSettings.actions.testSucceeded')}
                </span>
              ) : testPhase === 'failure' ? (
                <span className="flex items-center gap-1.5 text-red-600">
                  <Icon name="cancel" size={14} />
                  {t('integrationsSettings.actions.testFailed')}
                </span>
              ) : (
                isSlack ? t('integrationsSettings.actions.sendTestMessage') : t('integrationsSettings.actions.testConnection')
              )}
            </Button>
            <div className="flex-1" />
            <Button type="button" variant="secondary" className="rounded-xl" onClick={onClose}>
              {t('integrationsSettings.actions.cancel')}
            </Button>
            <Button
              type="button"
              className="rounded-xl font-bold text-white px-5 flex items-center gap-2"
              style={{ background: 'linear-gradient(135deg, var(--color-primary), #8329c8)' }}
              disabled={!formValid || saving}
              onClick={handleSave}
              data-testid="save-button"
            >
              {saving ? (
                <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin border-white" />
              ) : (
                t('integrationsSettings.actions.save')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDisconnect} onOpenChange={(o) => { if (!o) setConfirmDisconnect(false); }}>
        <DialogContent
          className="w-full max-w-md p-0 overflow-hidden rounded-2xl"
          style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(32px)', border: '1px solid rgba(255,255,255,0.7)', boxShadow: '0 40px 80px -20px rgba(0,0,0,0.22)' }}
        >
          <div className="px-7 pt-7 pb-5" style={{ borderBottom: '1px solid rgba(220,38,38,0.1)', background: 'rgba(220,38,38,0.04)' }}>
            <DialogHeader>
              <DialogTitle className="text-lg font-extrabold font-headline text-red-600">
                {t('integrationsSettings.disconnectConfirm.title', { connector: meta.label })}
              </DialogTitle>
            </DialogHeader>
          </div>
          <div className="px-7 py-5">
            <p className="text-sm text-on-surface-variant">
              {t('integrationsSettings.disconnectConfirm.body', { connector: meta.label })}
            </p>
          </div>
          <DialogFooter className="flex gap-3 px-7 pb-7">
            <Button variant="secondary" className="flex-1 rounded-xl" onClick={() => setConfirmDisconnect(false)}>
              {t('integrationsSettings.disconnectConfirm.cancelButton')}
            </Button>
            <Button
              variant="destructive"
              className="flex-1 rounded-xl flex items-center justify-center gap-2"
              disabled={disconnecting}
              onClick={handleDisconnect}
              data-testid="confirm-disconnect-button"
            >
              {disconnecting ? (
                <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin border-white" />
              ) : (
                <>
                  <Icon name="link_off" size={14} />
                  {t('integrationsSettings.disconnectConfirm.confirmButton')}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
