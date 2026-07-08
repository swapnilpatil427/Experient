import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from '../lib/i18n';
import { useApi } from '../hooks/useApi';
import { useSetPageTitle } from '../contexts/pageTitle';
import { Icon } from '../components/Icon';
import { Button } from '@/components/ui/button';
import { PageHeader } from '../components/PageHeader';
import { GlassCard, SENTIMENT_BORDER } from './insights/shared';
import { ROUTES, toPath } from '../constants/routes';
import type { Survey, SurveyResponse } from '../types';

/**
 * R-T5's audit-trail terminus — the actual cited response, not just the
 * checkpoint that summarized it. Survey-scoped route
 * (`/app/surveys/:surveyId/responses/:responseId`) so backend access-control
 * mirrors how response data is scoped everywhere else (TRACKER.md Task 16).
 *
 * Access-control re-check and the soft-delete (`deleted_at IS NULL`) guard
 * are backend concerns — this page's job is the shell + graceful "unavailable"
 * state when `getSurveyResponse` returns null (backend 404s for either case).
 */
export function ResponseDetailPage() {
  const { t } = useTranslation();
  const { surveyId, responseId } = useParams<{ surveyId: string; responseId: string }>();
  const navigate = useNavigate();
  const api = useApi();

  const [survey, setSurvey] = useState<Survey | null>(null);
  const [response, setResponse] = useState<SurveyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useSetPageTitle(t('tagReport.responseDetail.title'));

  useEffect(() => {
    if (!surveyId || !responseId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.getSurvey(surveyId).catch(() => null),
      api.getSurveyResponse(surveyId, responseId),
    ]).then(([surveyRes, responseRes]) => {
      if (cancelled) return;
      setSurvey(surveyRes?.survey ?? null);
      if (!responseRes) {
        setNotFound(true);
      } else {
        setResponse(responseRes.response);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [surveyId, responseId, api]);

  const crumbs = [
    { label: survey?.title ?? t('tagReport.responseDetail.title'), path: surveyId ? toPath(ROUTES.RESPONSE_DASHBOARD, { surveyId }) : ROUTES.SURVEYS },
    { label: t('tagReport.responseDetail.title') },
  ];

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto w-full flex items-center justify-center py-32">
        <div className="w-10 h-10 rounded-full border-2 animate-spin"
          style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', borderTopColor: 'var(--color-primary)' }} />
      </div>
    );
  }

  if (notFound || !response) {
    return (
      <div className="max-w-3xl mx-auto w-full">
        <PageHeader crumbs={crumbs} title={t('tagReport.responseDetail.title')} />
        <div className="rounded-xl border border-border p-12 text-center">
          <Icon name="visibility_off" size={40} className="text-muted-foreground mx-auto mb-4" />
          <p className="text-on-surface-variant">{t('tagReport.responseDetail.unavailable')}</p>
          {surveyId && (
            <Button className="mt-4" variant="outline" onClick={() => navigate(toPath(ROUTES.RESPONSE_DASHBOARD, { surveyId }))}>
              {t('tagReport.responseDetail.backToSurvey')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const questionById = new Map((survey?.questions ?? []).map((q) => [q.id, q]));

  return (
    <div className="max-w-3xl mx-auto w-full">
      <PageHeader crumbs={crumbs} title={t('tagReport.responseDetail.title')} />

      <GlassCard className="p-5 mb-4">
        <div className="flex items-center justify-between gap-2 mb-4">
          <span className="text-xs text-on-surface-variant">{new Date(response.submitted_at).toLocaleString()}</span>
          <div className="flex items-center gap-2">
            {response.ai_sentiment && (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
                style={{ borderLeft: `3px solid ${SENTIMENT_BORDER[response.ai_sentiment] ?? SENTIMENT_BORDER.neutral}` }}>
                {t('tagReport.responseDetail.sentiment')}: {response.ai_sentiment}
              </span>
            )}
            {response.ai_emotion && (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-muted/60 text-on-surface-variant">
                {t('tagReport.responseDetail.emotion')}: {response.ai_emotion}
              </span>
            )}
          </div>
        </div>

        <div className="space-y-4">
          {response.answers.map((a, i) => {
            const q = questionById.get(a.questionId);
            return (
              <div key={i} className="pb-3 border-b border-border/50 last:border-0 last:pb-0">
                <p className="text-xs font-semibold text-on-surface-variant mb-1">
                  {q?.question ?? t('tagReport.responseDetail.context')}
                </p>
                <p className="text-sm text-on-surface">{String(a.value)}</p>
              </div>
            );
          })}
        </div>
      </GlassCard>

      {surveyId && (
        <Button variant="outline" onClick={() => navigate(toPath(ROUTES.RESPONSE_DASHBOARD, { surveyId }))} className="rounded-xl">
          <Icon name="arrow_back" size={14} className="mr-1.5" />
          {t('tagReport.responseDetail.backToSurvey')}
        </Button>
      )}
    </div>
  );
}
