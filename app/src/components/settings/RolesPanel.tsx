import { useState, useEffect, useCallback } from 'react';
import { Icon } from '../Icon';
import { Card } from '@/components/ui/card';
import { useApi } from '../../hooks/useApi';
import { useTranslation } from '../../lib/i18n';
import type { DirectoryRole, PermissionScope } from '../../lib/api';

// Read-only awareness of the org's role catalog and what each role is allowed to do.
// Backed by /api/roles (users:manage gated), so this panel is only shown to admins.

const SCOPE_STYLE: Record<PermissionScope, string> = {
  ALL:    'bg-emerald-100 text-emerald-700',
  OWNED:  'bg-blue-100 text-blue-700',
  OWN:    'bg-blue-100 text-blue-700',
  SHARED: 'bg-amber-100 text-amber-700',
  NONE:   'bg-muted text-muted-foreground',
};

const humanizeAction = (key: string) => key.replace(/[:_]/g, ' ');

export function RolesPanel() {
  const { t } = useTranslation();
  const api = useApi();
  const [roles, setRoles] = useState<DirectoryRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const { roles: list } = await api.listRoles();
      setRoles(list ?? []);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6 py-2">
      <div>
        <h3 className="text-lg font-bold font-headline text-on-surface">{t('settings.roles.heading')}</h3>
        <p className="text-sm text-on-surface-variant mt-1">{t('settings.roles.description')}</p>
      </div>

      {loading && (
        <div className="flex justify-center py-8">
          <div className="w-6 h-6 rounded-full border-2 animate-spin"
            style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', borderTopColor: 'var(--color-primary)' }} />
        </div>
      )}

      {!loading && failed && (
        <p className="text-sm text-muted-foreground py-4">{t('settings.roles.loadError')}</p>
      )}

      {!loading && !failed && roles.map((role) => {
        const granted = Object.entries(role.permissions || {})
          .filter(([, scope]) => scope && scope !== 'NONE');
        return (
          <Card key={role.id} className="p-6">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <Icon name="badge" size={18} className="text-primary" />
                  <h4 className="font-bold text-on-surface">{role.name}</h4>
                  {role.isBuiltin && (
                    <span className="text-[10px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                      {t('settings.roles.builtin')}
                    </span>
                  )}
                </div>
                {role.description && (
                  <p className="text-sm text-on-surface-variant mt-1">{role.description}</p>
                )}
              </div>
              {role.seatWeight != null && (
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {t('settings.roles.seats', { weight: role.seatWeight })}
                </span>
              )}
            </div>

            {granted.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('settings.roles.noPermissions')}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {granted.map(([action, scope]) => (
                  <span
                    key={action}
                    className="inline-flex items-center gap-1 text-xs rounded-md px-2 py-1 bg-muted/40"
                  >
                    <span className="text-on-surface-variant">{humanizeAction(action)}</span>
                    <span className={`font-bold rounded px-1 ${SCOPE_STYLE[scope]}`}>{scope}</span>
                  </span>
                ))}
              </div>
            )}
          </Card>
        );
      })}

      {!loading && !failed && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Icon name="info" size={14} />
          {t('settings.roles.editHint')}
        </p>
      )}
    </div>
  );
}
