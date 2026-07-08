import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from 'react';
import { useTranslation } from '../../../lib/i18n';
import { useApi } from '../../../hooks/useApi';
import { Icon } from '../../Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { DirectoryUser, NotificationTargetOption, NotifyTarget } from '../../../lib/api';

export interface NotifyTargetPickerProps {
  value: NotifyTarget | undefined;
  onChange: (target: NotifyTarget) => void;
}

type Mode = NotifyTarget['targetType'];

const MODES: Mode[] = ['users', 'role', 'department', 'group'];

// Shared "Notify who?" targeting control for notify.email and notify.in_app
// (Wave 9 — see docs/automation-hub/TEMPLATE_FLOW_AND_RECIPIENT_TARGETING_SPEC.md
// §Issue 2). 4-way mode toggle (people/role/department/group) + a per-mode
// picker + a live "this will notify N people" summary line, which the spec
// flags as the single highest-value piece of this UI.
//
// No `Command`/`Popover` combobox primitive is used here deliberately — this
// app doesn't otherwise use those primitives, so "Specific people" mode is
// built as a plain debounced search Input + an absolutely-positioned result
// list, matching UserDirectoryPage's search box styling.
export function NotifyTargetPicker({ value, onChange }: NotifyTargetPickerProps) {
  const { t } = useTranslation();
  const api = useApi();

  const [mode, setMode] = useState<Mode>(value?.targetType ?? 'users');

  // "Specific people" mode state.
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState<Array<{ userId: string; label: string }>>([]);
  // A-2 (DEEP_AUDIT_UX_FINDINGS.md §8) — WAI-ARIA combobox keyboard nav:
  // which result row is highlighted (-1 = none), moved by ArrowUp/ArrowDown,
  // committed by Enter, cleared by Escape (which also closes the listbox).
  const [activeIndex, setActiveIndex] = useState(-1);
  // Which userIds' display names have already been resolved/requested, so
  // re-renders don't refetch. Handles both a normal edit-mode reload
  // (`targetType: 'users'`) and the legacy `userId`/`userIds`-only shape —
  // by the time `value` reaches this component it has already been normalized
  // to `{ targetType: 'users', userIds }` by the caller's legacy-compat
  // hydration (see hydrateLegacyNotifyTarget in AdvancedFieldsDisclosure.tsx),
  // so this component only ever needs to resolve ids into names, not branch
  // on legacy shape itself.
  const resolvedIdsRef = useRef<Set<string>>(new Set());

  // Role/department/group mode state — fetched lazily (only when that mode is
  // selected), from the single notification-targets endpoint (gated by
  // `workflows:manage`, not `users:manage`, so any workflow author can call it).
  const [targets, setTargets] = useState<{ roles: NotificationTargetOption[]; departments: NotificationTargetOption[]; groups: NotificationTargetOption[] } | null>(null);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [targetsError, setTargetsError] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  // Sync mode when `value` changes externally (e.g. switching between actions).
  useEffect(() => {
    setMode(value?.targetType ?? 'users');
  }, [value?.targetType]);

  // Resolve display names for any userIds already present on `value` that
  // aren't in local state yet (initial mount with a pre-populated target —
  // edit-mode reload or a legacy-shape config normalized upstream). Runs
  // once per new id set; best-effort (falls back to showing the raw id if
  // the lookup fails, rather than silently dropping the chip).
  useEffect(() => {
    if (value?.targetType !== 'users') return;
    const missing = value.userIds.filter((id) => !resolvedIdsRef.current.has(id) && !selectedUsers.some((u) => u.userId === id));
    if (missing.length === 0) return;
    missing.forEach((id) => resolvedIdsRef.current.add(id));
    Promise.all(missing.map((id) =>
      api.getUser(id).then(({ user }) => ({ userId: id, label: user.displayName || user.email }))
        .catch(() => ({ userId: id, label: id })),
    )).then((resolved) => {
      setSelectedUsers((prev) => [...prev, ...resolved.filter((r) => !prev.some((u) => u.userId === r.userId))]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Debounced server-side user search (250ms), matches UserDirectoryPage.
  useEffect(() => {
    if (mode !== 'users' || !query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    const handle = setTimeout(() => {
      api.listUsers({ search: query, limit: 10 })
        .then((res) => setResults(res.users))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode]);

  // Reset the highlighted row whenever the result set changes, so a stale
  // index from a previous search never points at the wrong row.
  useEffect(() => {
    setActiveIndex(results.length > 0 ? 0 : -1);
  }, [results]);

  const loadTargets = useCallback(() => {
    if (targets || targetsLoading) return;
    setTargetsLoading(true);
    setTargetsError(false);
    api.getNotificationTargets()
      .then((res) => setTargets(res))
      .catch(() => setTargetsError(true))
      .finally(() => setTargetsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, targetsLoading]);

  useEffect(() => {
    if (mode !== 'users') loadTargets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Close the results dropdown on outside click.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function selectMode(next: Mode) {
    setMode(next);
    if (next === 'users') {
      onChange({ targetType: 'users', userIds: selectedUsers.map((u) => u.userId) });
    } else if (next === 'role') {
      onChange({ targetType: 'role', roleId: value?.targetType === 'role' ? value.roleId : '' });
    } else if (next === 'department') {
      onChange({ targetType: 'department', departmentId: value?.targetType === 'department' ? value.departmentId : '' });
    } else {
      onChange({ targetType: 'group', groupId: value?.targetType === 'group' ? value.groupId : '' });
    }
  }

  function addUser(user: DirectoryUser) {
    if (selectedUsers.some((u) => u.userId === user.userId)) return;
    const label = user.displayName || user.email;
    const next = [...selectedUsers, { userId: user.userId, label }];
    setSelectedUsers(next);
    setQuery('');
    setResults([]);
    setShowResults(false);
    onChange({ targetType: 'users', userIds: next.map((u) => u.userId) });
  }

  function removeUser(userId: string) {
    const next = selectedUsers.filter((u) => u.userId !== userId);
    setSelectedUsers(next);
    onChange({ targetType: 'users', userIds: next.map((u) => u.userId) });
  }

  // A-2 (DEEP_AUDIT_UX_FINDINGS.md §8) — minimal WAI-ARIA combobox keyboard
  // pattern: ArrowDown/ArrowUp move the highlighted option, Enter commits it,
  // Escape closes the listbox. Deliberately not pulling in a new dependency —
  // this mirrors the existing plain-Input + absolutely-positioned-list markup,
  // just adding the roles/attributes the pattern requires.
  function handleSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setShowResults(false);
      setActiveIndex(-1);
      return;
    }
    if (!showResults || results.length === 0) {
      if (e.key === 'ArrowDown' && query.trim()) setShowResults(true);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < results.length) addUser(results[activeIndex]);
    }
  }

  const selectedRole = mode === 'role' && value?.targetType === 'role'
    ? targets?.roles.find((r) => r.id === value.roleId)
    : undefined;
  const selectedDept = mode === 'department' && value?.targetType === 'department'
    ? targets?.departments.find((d) => d.id === value.departmentId)
    : undefined;
  const selectedGroup = mode === 'group' && value?.targetType === 'group'
    ? targets?.groups.find((g) => g.id === value.groupId)
    : undefined;

  function renderSummary() {
    if (mode === 'users') {
      const n = selectedUsers.length;
      if (n === 0) return null;
      return summaryLine(n === 1
        ? t('workflows.builder.sentence.notifyTarget.summaryPeopleOne')
        : t('workflows.builder.sentence.notifyTarget.summaryPeopleOther', { count: n }));
    }
    if (mode === 'role') {
      if (!value || value.targetType !== 'role' || !value.roleId) return null;
      if (!selectedRole) return null;
      if (selectedRole.memberCount === 0) {
        return summaryLine(t('workflows.builder.sentence.notifyTarget.summaryZeroRole', { name: selectedRole.name }), true);
      }
      return summaryLine(t('workflows.builder.sentence.notifyTarget.summaryRole', { count: selectedRole.memberCount, name: selectedRole.name }));
    }
    if (mode === 'department') {
      if (!value || value.targetType !== 'department' || !value.departmentId) return null;
      if (!selectedDept) return null;
      if (selectedDept.memberCount === 0) {
        return summaryLine(t('workflows.builder.sentence.notifyTarget.summaryZeroDepartment', { name: selectedDept.name }), true);
      }
      return summaryLine(t('workflows.builder.sentence.notifyTarget.summaryDepartment', { count: selectedDept.memberCount, name: selectedDept.name }));
    }
    if (mode === 'group') {
      if (!value || value.targetType !== 'group' || !value.groupId) return null;
      if (!selectedGroup) return null;
      if (selectedGroup.memberCount === 0) {
        return summaryLine(t('workflows.builder.sentence.notifyTarget.summaryZeroGroup', { name: selectedGroup.name }), true);
      }
      return summaryLine(t('workflows.builder.sentence.notifyTarget.summaryGroup', { count: selectedGroup.memberCount, name: selectedGroup.name }));
    }
    return null;
  }

  function summaryLine(text: string, warning = false) {
    return (
      <p
        data-testid="notify-target-summary"
        className={cn('text-xs flex items-center gap-1 mt-2', warning ? 'text-warning font-semibold' : 'text-on-surface-variant')}
      >
        <Icon name={warning ? 'warning' : 'groups'} size={13} />
        {text}
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="notify-target-picker">
      {/* Mode selector — 4 toggle buttons, matching ScopeFilterBar's pill-group pattern */}
      <div className="flex items-center gap-1.5 flex-wrap rounded-xl bg-surface-container-low p-1 w-fit" data-testid="notify-target-mode-selector">
        {MODES.map((m) => (
          <Button
            key={m}
            type="button"
            variant={mode === m ? 'default' : 'outline'}
            size="sm"
            aria-pressed={mode === m}
            className={cn('rounded-lg border-0', mode !== m && 'bg-transparent shadow-none')}
            data-testid={`notify-target-mode-${m}`}
            onClick={() => selectMode(m)}
          >
            {t(`workflows.builder.sentence.notifyTarget.mode.${m}`)}
          </Button>
        ))}
      </div>

      {/* Per-mode picker */}
      {mode === 'users' && (
        <div className="space-y-2" ref={containerRef}>
          {selectedUsers.length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-testid="notify-target-people-chips">
              {selectedUsers.map((u) => (
                <Badge key={u.userId} variant="outline" className="normal-case font-semibold text-xs gap-1 pr-1">
                  {u.label}
                  <button
                    type="button"
                    aria-label={t('workflows.builder.sentence.notifyTarget.removePersonAria', { name: u.label })}
                    onClick={() => removeUser(u.userId)}
                    className="ml-0.5 hover:opacity-70"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <div className="relative">
            <Icon name="search" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
            {/* A-2 (DEEP_AUDIT_UX_FINDINGS.md §8) — minimal WAI-ARIA 1.2
                combobox pattern: role="combobox" + aria-expanded +
                aria-controls + aria-activedescendant on the input, role="listbox"
                on the results container, role="option" + matching id on each
                row. Arrow keys move `activeIndex`, Enter commits, Escape closes
                (handleSearchKeyDown above) — no new dependency pulled in. */}
            <Input
              className="pl-8"
              placeholder={t('workflows.builder.sentence.notifyTarget.searchPlaceholder')}
              value={query}
              role="combobox"
              aria-expanded={showResults && Boolean(query.trim())}
              aria-controls="notify-target-people-listbox"
              aria-autocomplete="list"
              aria-activedescendant={activeIndex >= 0 && results[activeIndex] ? `notify-target-option-${results[activeIndex].userId}` : undefined}
              onFocus={() => setShowResults(true)}
              onChange={(e) => { setQuery(e.target.value); setShowResults(true); }}
              onKeyDown={handleSearchKeyDown}
              data-testid="notify-target-people-search"
            />
            {showResults && query.trim() && (
              <div
                id="notify-target-people-listbox"
                role="listbox"
                aria-label={t('workflows.builder.sentence.notifyTarget.searchPlaceholder')}
                className="absolute z-10 mt-1 w-full rounded-xl bg-white shadow-lg border border-border max-h-56 overflow-y-auto"
                data-testid="notify-target-people-results"
              >
                {searching ? (
                  <p className="text-xs text-on-surface-variant p-3 flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full border-2 border-t-transparent animate-spin border-current" aria-hidden="true" />
                    <span className="sr-only">{t('common.loading')}</span>
                  </p>
                ) : results.length === 0 ? (
                  <p className="text-xs text-on-surface-variant p-3">{t('workflows.builder.sentence.notifyTarget.noResults')}</p>
                ) : (
                  results.map((u, i) => (
                    <button
                      key={u.userId}
                      id={`notify-target-option-${u.userId}`}
                      role="option"
                      aria-selected={i === activeIndex}
                      type="button"
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => addUser(u)}
                      className={cn(
                        'flex items-center gap-2 w-full text-left px-3 py-2 text-sm',
                        i === activeIndex ? 'bg-accent' : 'hover:bg-accent',
                      )}
                      data-testid={`notify-target-person-${u.userId}`}
                    >
                      <span className="font-semibold text-on-surface">{u.displayName || u.email}</span>
                      {u.displayName && <span className="text-xs text-on-surface-variant">{u.email}</span>}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {mode !== 'users' && (
        <div>
          {targetsLoading ? (
            <p className="text-xs text-on-surface-variant flex items-center gap-2">
              <span className="w-3 h-3 rounded-full border-2 border-t-transparent animate-spin border-current" aria-hidden="true" />
              <span className="sr-only">{t('common.loading')}</span>
            </p>
          ) : targetsError ? (
            <p className="text-xs text-on-surface-variant italic" data-testid="notify-target-permission-denied">
              {t('workflows.builder.sentence.notifyTarget.permissionDenied')}
            </p>
          ) : mode === 'role' ? (
            <Select
              value={value?.targetType === 'role' ? value.roleId : undefined}
              onValueChange={(roleId) => onChange({ targetType: 'role', roleId })}
            >
              <SelectTrigger data-testid="notify-target-role-select">
                <SelectValue placeholder={t('workflows.builder.sentence.notifyTarget.pickRole')} />
              </SelectTrigger>
              <SelectContent>
                {(targets?.roles ?? []).map((r) => (
                  <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : mode === 'department' ? (
            <Select
              value={value?.targetType === 'department' ? value.departmentId : undefined}
              onValueChange={(departmentId) => onChange({ targetType: 'department', departmentId })}
            >
              <SelectTrigger data-testid="notify-target-department-select">
                <SelectValue placeholder={t('workflows.builder.sentence.notifyTarget.pickDepartment')} />
              </SelectTrigger>
              <SelectContent>
                {(targets?.departments ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Select
              value={value?.targetType === 'group' ? value.groupId : undefined}
              onValueChange={(groupId) => onChange({ targetType: 'group', groupId })}
            >
              <SelectTrigger data-testid="notify-target-group-select">
                <SelectValue placeholder={t('workflows.builder.sentence.notifyTarget.pickGroup')} />
              </SelectTrigger>
              <SelectContent>
                {(targets?.groups ?? []).map((g) => (
                  <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {renderSummary()}
    </div>
  );
}
