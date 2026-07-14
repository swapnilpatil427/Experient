// WarRoomToggle — dark theme toggle + localStorage persistence
// (`org_dashboard_dark_mode`), per DESIGN.md §9.
//
// `useWarRoomMode()` owns the boolean + persistence; the toggle button is a
// thin presentational piece so the full Command Center page
// (`OrgTrendsPage.tsx`) can apply `data-theme="war-room"` to its own page
// root (not `document.documentElement`) — this keeps War Room Mode scoped to
// Command Center only, never leaking the dark theme to the rest of the app.

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { useTranslation } from '../../lib/i18n';

const STORAGE_KEY = 'org_dashboard_dark_mode';

export function useWarRoomMode(): [boolean, () => void] {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_KEY) === 'true'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(enabled)); } catch { /* ignore quota/private-mode errors */ }
  }, [enabled]);

  const toggle = useCallback(() => setEnabled((v) => !v), []);
  return [enabled, toggle];
}

export function WarRoomToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm font-medium hover:bg-surface-container transition-colors"
    >
      <span className="flex items-center gap-2">
        <Icon name={enabled ? 'dark_mode' : 'light_mode'} size={16} />
        {t('orgDashboard.warRoomMode.toggle')}
      </span>
      <span
        className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0"
        style={{ background: enabled ? 'var(--color-primary)' : 'var(--color-outline-variant)' }}
      >
        <span
          className="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
          style={{ transform: enabled ? 'translateX(18px)' : 'translateX(2px)' }}
        />
      </span>
    </button>
  );
}
