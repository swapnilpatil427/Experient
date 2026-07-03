import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../lib/i18n';
import { useApi } from '../../hooks/useApi';
import { useTagReport } from '../../hooks/useTagReport';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '../../components/PageHeader';
import { GlassCard } from '../insights/shared';
import { ROUTES, toPath } from '../../constants/routes';

/** Mode-picker page — TAG_REPORT_NEW — trigger a Manual or Custom Range run. */
export function TagReportNewPage() {
  const { t } = useTranslation();
  const { tagId } = useParams<{ tagId: string }>();
  const navigate = useNavigate();
  const api = useApi();
  const { generate } = useTagReport(tagId, undefined);

  const [tagName, setTagName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<'manual' | 'custom_range' | null>(null);
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  // Client-side validation errors (window required/order) use these fixed
  // strings as-is. Server-side generation failures use the SPECIFIC message
  // `generate()` returns (no surveys / rate limit / tag not found) rather than
  // one fixed generic string for every failure mode (fixed 2026-07-03,
  // customer-journey review finding: "generic error masking").
  const [formError, setFormError] = useState<string | null>(null);

  useSetPageTitle(t('tagReport.new.title'));

  useEffect(() => {
    if (!tagId) return;
    api.getTagSurveys(tagId).then((res) => setTagName(res.tag.name)).catch(() => {});
  }, [tagId, api]);

  async function handleManual() {
    if (!tagId) return;
    setSubmitting('manual');
    setFormError(null);
    const { runId, error, inFlightNotice } = await generate({ mode: 'manual' });
    setSubmitting(null);
    // Fixed 2026-07-03 (customer-journey review finding: "InFlightRunBanner
    // unreachable") — this page's own useTagReport instance (and its
    // inFlightNotice state) is discarded the instant we navigate away.
    // Forwarding the notice through router navigation state lets the
    // DESTINATION page (TagReportPage, a fresh hook instance) show it.
    if (runId) navigate(toPath(ROUTES.TAG_REPORT, { tagId, runId }), { state: { inFlightNotice } });
    else setFormError(error || t('tagReport.new.errorGeneric'));
  }

  async function handleCustomRange() {
    if (!tagId) return;
    if (!windowStart || !windowEnd) {
      setFormError(t('tagReport.new.errorWindowRequired'));
      return;
    }
    if (new Date(windowEnd).getTime() <= new Date(windowStart).getTime()) {
      setFormError(t('tagReport.new.errorWindowOrder'));
      return;
    }
    setSubmitting('custom_range');
    setFormError(null);
    const { runId, error, inFlightNotice } = await generate({
      mode: 'custom_range',
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
    });
    setSubmitting(null);
    if (runId) navigate(toPath(ROUTES.TAG_REPORT, { tagId, runId }), { state: { inFlightNotice } });
    else setFormError(error || t('tagReport.new.errorGeneric'));
  }

  return (
    <div className="max-w-4xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: t('tagReport.breadcrumbs.experience'), path: ROUTES.EXPERIENCE },
          { label: t('tagReport.breadcrumbs.reports'), path: ROUTES.TAG_REPORTS_INDEX },
          { label: t('tagReport.new.title') },
        ]}
        title={t('tagReport.new.title')}
        subtitle={tagName ? t('tagReport.new.subtitle', { tagName }) : undefined}
      />

      {formError && <div className="banner-error mb-4">{formError}</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <GlassCard className="p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)', color: 'var(--color-primary)' }}>
              <Icon name="bolt" size={16} />
            </span>
            <h3 className="font-bold text-on-surface">{t('tagReport.new.manualTitle')}</h3>
          </div>
          <p className="text-sm text-on-surface-variant flex-1">{t('tagReport.new.manualDescription')}</p>
          <Button
            onClick={handleManual}
            disabled={submitting !== null}
            style={{ background: 'var(--color-primary)' }}
            className="rounded-xl font-headline"
          >
            {submitting === 'manual' ? t('tagReport.new.generating') : t('tagReport.new.manualCta')}
          </Button>
        </GlassCard>

        <GlassCard className="p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: '#8b5cf615', color: '#8b5cf6' }}>
              <Icon name="date_range" size={16} />
            </span>
            <h3 className="font-bold text-on-surface">{t('tagReport.new.customRangeTitle')}</h3>
          </div>
          <p className="text-sm text-on-surface-variant">{t('tagReport.new.customRangeDescription')}</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="window-start">{t('tagReport.new.windowStartLabel')}</Label>
              <Input id="window-start" type="date" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="window-end">{t('tagReport.new.windowEndLabel')}</Label>
              <Input id="window-end" type="date" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
            </div>
          </div>
          <Button
            onClick={handleCustomRange}
            disabled={submitting !== null}
            variant="outline"
            className="rounded-xl font-headline"
          >
            {submitting === 'custom_range' ? t('tagReport.new.generating') : t('tagReport.new.customRangeCta')}
          </Button>
        </GlassCard>
      </div>
    </div>
  );
}
