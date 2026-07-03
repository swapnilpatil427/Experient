import { useState, useEffect, useCallback } from 'react';
import { Icon } from '../Icon';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { useApi } from '../../hooks/useApi';
import { useTranslation } from '../../lib/i18n';
import { usePermissions } from '../../lib/permissions';
import { useAppAuth } from '../../lib/auth.tsx';
import { useBrand } from '../../contexts/brandContext';
import type { OrgMember } from '../../types';

// Roles offered in the invite / change-role selects. Limited to Clerk's default
// org roles so assignment never fails against a free-plan instance that hasn't
// defined custom roles. Other roles (analyst, etc.) still display if already set.
const ASSIGNABLE_ROLES = ['org:admin', 'org:member'] as const;

type Banner = { kind: 'success' | 'error'; text: string } | null;

export function TeamPanel() {
  const { t } = useTranslation();
  const api = useApi();
  const { userId } = useAppAuth();
  const { brandName } = useBrand();
  const { role, isAdmin, isAnalyst, isViewer } = usePermissions();

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<string>('org:member');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const roleLabels = t('settings.team.roles') as unknown as Record<string, string>;
  const humanizeRole = (r: string) =>
    (roleLabels && roleLabels[r]) || r.replace('org:', '').replace(/_/g, ' ');

  const errDetail = (e: unknown) => {
    const ax = e as { response?: { data?: { error?: string } }; message?: string };
    return ax?.response?.data?.error || ax?.message || '';
  };

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const { members: list } = await api.getMembers();
      setMembers(list ?? []);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  // Capabilities summary for the "Your Access" card — awareness of what this role grants.
  const capabilities: string[] = (() => {
    if (isAdmin) return [
      t('settings.team.capability.manageTeam'),
      t('settings.team.capability.editSurveys'),
      t('settings.team.capability.generateInsights'),
    ];
    if (isAnalyst) return [
      t('settings.team.capability.generateInsights'),
      t('settings.team.capability.readOnly'),
    ];
    if (isViewer) return [t('settings.team.capability.readOnly')];
    return [t('settings.team.capability.respondOnly')];
  })();

  const memberName = (m: OrgMember) =>
    [m.firstName, m.lastName].filter(Boolean).join(' ') || m.identifier || m.userId;

  const initials = (m: OrgMember) => {
    const name = memberName(m);
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  };

  const handleInvite = async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true);
    setBanner(null);
    try {
      await api.inviteMember(email, inviteRole);
      setBanner({ kind: 'success', text: t('settings.team.inviteSuccess', { email }) });
      setInviteEmail('');
      await load();
    } catch (e) {
      setBanner({ kind: 'error', text: t('settings.team.inviteError', { detail: errDetail(e) }) });
    } finally {
      setInviting(false);
    }
  };

  const handleRoleChange = async (m: OrgMember, newRole: string) => {
    if (newRole === m.role) return;
    setBusyId(m.userId);
    setBanner(null);
    try {
      await api.updateMemberRole(m.userId, newRole);
      await load();
    } catch (e) {
      setBanner({ kind: 'error', text: t('settings.team.changeRoleError', { detail: errDetail(e) }) });
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (m: OrgMember) => {
    if (!window.confirm(t('settings.team.removeConfirm', { name: memberName(m) }))) return;
    setBusyId(m.userId);
    setBanner(null);
    try {
      await api.removeMember(m.userId);
      await load();
    } catch (e) {
      setBanner({ kind: 'error', text: t('settings.team.removeError', { detail: errDetail(e) }) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-8">
      {/* ── Your Access (identity awareness) ── */}
      <Card className="p-6">
        <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4 font-headline">
          {t('settings.team.yourAccessHeading')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                {t('settings.team.orgLabel')}
              </div>
              <div className="flex items-center gap-2 text-on-surface font-semibold">
                <Icon name="business" size={18} className="text-primary" />
                {brandName || t('settings.team.unknownOrg')}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                {t('settings.team.roleLabel')}
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={isAdmin ? 'default' : 'secondary'} className="capitalize">
                  {role ? humanizeRole(role) : humanizeRole('org:member')}
                </Badge>
                {isAdmin && (
                  <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-600">
                    <Icon name="verified_user" size={14} fill={1} />
                    {t('settings.team.adminBadge')}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
              {t('settings.team.capabilitiesHeading')}
            </div>
            <ul className="space-y-1.5">
              {capabilities.map((cap) => (
                <li key={cap} className="flex items-start gap-2 text-sm text-on-surface-variant">
                  <Icon name="check_circle" size={16} fill={1} className="text-emerald-500 mt-0.5 shrink-0" />
                  {cap}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>

      {/* ── Banner ── */}
      {banner && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium ${
            banner.kind === 'success'
              ? 'bg-emerald-50 text-emerald-700'
              : 'bg-red-50 text-red-700'
          }`}
        >
          <Icon name={banner.kind === 'success' ? 'check_circle' : 'error'} size={18} fill={1} />
          {banner.text}
        </div>
      )}

      {/* ── Invite (admin only) ── */}
      {isAdmin && (
        <Card className="p-6">
          <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4 font-headline">
            {t('settings.team.inviteButton')}
          </h3>
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder={t('settings.team.invitePlaceholder')}
              className="flex-1"
            />
            <Select value={inviteRole} onValueChange={setInviteRole}>
              <SelectTrigger className="sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNABLE_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>{humanizeRole(r)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}>
              <Icon name="person_add" size={16} className="mr-1.5" />
              {t('settings.team.inviteCta')}
            </Button>
          </div>
        </Card>
      )}

      {/* ── Members ── */}
      <Card className="p-6">
        <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4 font-headline">
          {t('settings.team.membersHeading')}
        </h3>

        {loading && (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 rounded-full border-2 animate-spin"
              style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', borderTopColor: 'var(--color-primary)' }} />
          </div>
        )}

        {!loading && loadFailed && (
          <p className="text-sm text-muted-foreground py-4">{t('settings.team.loadError')}</p>
        )}

        {!loading && !loadFailed && members.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">{t('settings.team.emptyMembers')}</p>
        )}

        {!loading && !loadFailed && members.length > 0 && (
          <div className="divide-y divide-muted/15">
            {members.map((m) => {
              const isSelf = m.userId === userId;
              return (
                <div key={m.userId} className="flex items-center gap-3 py-3">
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0 bg-gradient-primary">
                    {initials(m)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-on-surface truncate">{memberName(m)}</span>
                      {isSelf && (
                        <span className="text-[10px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                          {t('settings.team.youBadge')}
                        </span>
                      )}
                    </div>
                    {m.identifier && (
                      <div className="text-xs text-muted-foreground truncate">{m.identifier}</div>
                    )}
                  </div>

                  {/* Admin can change role of others; self + non-admins see a static badge */}
                  {isAdmin && !isSelf ? (
                    <Select
                      value={ASSIGNABLE_ROLES.includes(m.role as typeof ASSIGNABLE_ROLES[number]) ? m.role : undefined}
                      onValueChange={(v) => handleRoleChange(m, v)}
                      disabled={busyId === m.userId}
                    >
                      <SelectTrigger className="w-36">
                        <SelectValue placeholder={humanizeRole(m.role)} />
                      </SelectTrigger>
                      <SelectContent>
                        {ASSIGNABLE_ROLES.map((r) => (
                          <SelectItem key={r} value={r}>{humanizeRole(r)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant={m.role === 'org:admin' ? 'default' : 'secondary'} className="capitalize">
                      {humanizeRole(m.role)}
                    </Badge>
                  )}

                  {isAdmin && !isSelf && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemove(m)}
                      disabled={busyId === m.userId}
                      title={t('settings.team.removeCta')}
                    >
                      <Icon name="person_remove" size={18} className="text-red-500" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!isAdmin && (
          <p className="text-xs text-muted-foreground mt-4 flex items-center gap-1.5">
            <Icon name="info" size={14} />
            {t('settings.team.adminOnlyHint')}
          </p>
        )}
      </Card>
    </div>
  );
}
