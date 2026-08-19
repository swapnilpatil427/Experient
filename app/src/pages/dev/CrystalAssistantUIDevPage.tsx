// Dev-only manual preview of the minimal assistant-ui adoption spike
// (docs/xperiq-assistant-ui/BRIEF.md). Never reachable in a production build:
// App.tsx only registers this route's `<Route>` element when
// `import.meta.env.DEV` is true, and this module is only ever reached via a
// `React.lazy()` import gated by that same check — mirrors the pattern the
// prior (rolled-back) assistant-ui-migration branch's `CrystalThreadShellDevPage.tsx`
// used (`git show assistant-ui-migration:app/src/pages/dev/CrystalThreadShellDevPage.tsx`).
//
// Dev-mode context mirrors CrystalPanel.tsx: no `VITE_CLERK_PUBLISHABLE_KEY` →
// `useAppAuth()`/`useApi()` resolve to the fixed dev-user/dev-org identity
// (root CLAUDE.md); no `CLERK_SECRET_KEY` → the backend accepts it. Survey
// scope comes from the same real `useSurveys()` hook every survey-scoped page
// already uses — first active survey if one exists, else portfolio ('all').
import { useMemo } from 'react';
import { useSurveys } from '../../hooks/useSurveys';
import { useTranslation } from '../../lib/i18n';
import { CrystalAssistantUI } from '../../components/assistant-ui-minimal/CrystalAssistantUI';

export function CrystalAssistantUIDevPage() {
  const { t } = useTranslation();
  const { surveys, loading: surveysLoading } = useSurveys();

  const activeSurvey = useMemo(
    () => surveys.find((s) => s.status === 'active' && !s.deleted_at) ?? null,
    [surveys],
  );
  const isAll = !activeSurvey;

  return (
    <div className="mx-auto flex h-screen w-full max-w-5xl flex-col gap-3 px-4 py-6">
      <div
        className="rounded-xl border px-4 py-2 text-xs font-bold"
        style={{ borderColor: 'var(--color-outline-variant)', color: 'var(--color-on-surface-variant)' }}
      >
        {t('crystalAssistantUi.devBanner')} ·{' '}
        {surveysLoading ? t('crystalAssistantUi.scopeLoading') : isAll ? t('crystalAssistantUi.scopeAll') : activeSurvey?.title}
      </div>
      <div className="min-h-0 flex-1">
        <CrystalAssistantUI surveyId={activeSurvey?.id} />
      </div>
    </div>
  );
}
