// ManualSummaryGenerator — "Ask Crystal for a Brief" / "Generate custom
// summary". DESIGN.md's "Manual Summary Generator" section.
//
// Dialog on desktop/tablet, Sheet on mobile (branch on `useBreakpoint()`, not
// a CSS media query, since Dialog/Sheet are different Radix primitives).
// Date range capped at 90 days (Decision 16 item 3's reconciled range cap —
// `RANGE_TOO_LARGE`/`RANGE_NOT_COVERED` are server-enforced; this dialog
// disables the obviously-invalid range client-side rather than letting the
// user submit a request that will be rejected).
//
// No dedicated `CalendarDateRangePicker` component exists anywhere in this
// codebase (verified by direct search) — DESIGN.md references it as if
// already shared with the FilterBar, but the FilterBar itself is one of the
// aspirational, not-yet-built TopNav pieces this pass doesn't build either.
// This dialog uses plain native date inputs instead of inventing a new
// full calendar-picker component for a single call site — a judgment call,
// flagged here rather than silently building unrequested new shared UI.

import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Icon } from '../Icon';
import { useTranslation } from '../../lib/i18n';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useOrgSummaries } from '../../hooks/useOrgDashboard';
import { ManualRunError } from '../../lib/api';
import type { SummaryPreviewResponse, CreateSummaryResponse } from '../../types/orgDashboard';

const MAX_RANGE_DAYS = 90;

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ManualSummaryGenerator({
  open, onOpenChange, onGenerated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGenerated: (res: CreateSummaryResponse) => void;
}) {
  const { t } = useTranslation();
  const bp = useBreakpoint();
  const { preview: fetchPreview, create } = useOrgSummaries();

  const [start, setStart] = useState('');
  const [end, setEnd]     = useState(todayIso());
  const [preview, setPreview] = useState<SummaryPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const rangeDays = start && end ? daysBetween(start, end) : 0;
  const rangeValid = !!start && !!end && rangeDays > 0 && rangeDays <= MAX_RANGE_DAYS;

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setErrorMessage(null);
      setErrorCode(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !rangeValid) { setPreview(null); return; }
    let cancelled = false;
    setPreviewLoading(true);
    setErrorMessage(null);
    const id = setTimeout(() => {
      fetchPreview({ dateRangeStart: start, dateRangeEnd: end })
        .then((p) => { if (!cancelled) setPreview(p); })
        .catch((err) => {
          if (cancelled) return;
          setPreview(null);
          if (err instanceof ManualRunError) {
            setErrorCode(err.code);
            setErrorMessage(
              err.code === 'INSUFFICIENT_CREDITS' ? t('orgDashboard.manualSummary.errorCredits')
              : err.code === 'RATE_LIMITED' ? t('orgDashboard.manualSummary.errorRateLimited')
              : t('orgDashboard.manualSummary.errorGeneric'),
            );
          } else {
            setErrorMessage(t('orgDashboard.manualSummary.errorGeneric'));
          }
        })
        .finally(() => { if (!cancelled) setPreviewLoading(false); });
    }, 350); // debounce
    return () => { cancelled = true; clearTimeout(id); };
  }, [open, rangeValid, start, end, fetchPreview, t]);

  const canGenerate = rangeValid && !!preview && !previewLoading && !submitting && !preview.exceedsMaxRange;

  const handleGenerate = async () => {
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const res = await create({ dateRangeStart: start, dateRangeEnd: end });
      onGenerated(res);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ManualRunError) {
        setErrorCode(err.code);
        setErrorMessage(
          err.code === 'INSUFFICIENT_CREDITS' ? t('orgDashboard.manualSummary.errorCredits')
          : err.code === 'RATE_LIMITED' ? t('orgDashboard.manualSummary.errorRateLimited')
          : t('orgDashboard.manualSummary.errorGeneric'),
        );
      } else {
        setErrorMessage(t('orgDashboard.manualSummary.errorGeneric'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const body = useMemo(() => (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">
          <span className="block text-xs font-medium text-on-surface-variant mb-1">{t('orgDashboard.manualSummary.rangeStart')}</span>
          <input
            type="date"
            value={start}
            max={end || todayIso()}
            onChange={(e) => setStart(e.target.value)}
            className="w-full border border-outline-variant/40 rounded-lg px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="block text-xs font-medium text-on-surface-variant mb-1">{t('orgDashboard.manualSummary.rangeEnd')}</span>
          <input
            type="date"
            value={end}
            min={start}
            max={todayIso()}
            onChange={(e) => setEnd(e.target.value)}
            className="w-full border border-outline-variant/40 rounded-lg px-2 py-1.5 text-sm"
          />
        </label>
      </div>

      {start && end && !rangeValid && (
        <p className="text-xs text-red-600">{t('orgDashboard.manualSummary.rangeInvalid', { max: String(MAX_RANGE_DAYS) })}</p>
      )}

      {rangeValid && (
        <div className="rounded-lg bg-surface-container/50 p-3 space-y-1.5">
          {previewLoading && <div className="h-16 rounded bg-surface-container animate-pulse" />}
          {!previewLoading && preview && (
            <>
              <div className="flex justify-between text-xs">
                <span className="text-on-surface-variant">{t('orgDashboard.manualSummary.previewPrograms')}</span>
                <span className="font-mono tabular-nums">{preview.programsIncluded}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-on-surface-variant">{t('orgDashboard.manualSummary.previewResponses')}</span>
                <span className="font-mono tabular-nums">{preview.responseCount.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-on-surface-variant">{t('orgDashboard.manualSummary.previewCost')}</span>
                <span className="font-mono tabular-nums">{t('orgDashboard.manualSummary.previewCostValue', { cost: String(preview.estimatedCost) })}</span>
              </div>
              {preview.lowConfidence && (
                <p className="text-[11px] text-amber-600 flex items-center gap-1 pt-1">
                  <Icon name="info" size={12} />
                  {t('orgDashboard.manualSummary.lowConfidence')}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {errorMessage && (
        <div className="rounded-lg bg-red-50 border border-red-100 p-3">
          <p className="text-xs text-red-700">{errorMessage}</p>
          {errorCode === 'INSUFFICIENT_CREDITS' && (
            <p className="text-[11px] text-red-500 mt-1">{t('orgDashboard.manualSummary.reduceRangeHint')}</p>
          )}
        </div>
      )}
    </div>
  ), [start, end, rangeValid, previewLoading, preview, errorMessage, errorCode, t]);

  const footer = (
    <div className="flex justify-end gap-2 w-full">
      <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
      <Button variant="gradient" size="sm" disabled={!canGenerate} onClick={handleGenerate}>
        {submitting ? t('orgDashboard.manualSummary.generating') : t('orgDashboard.manualSummary.generate')}
      </Button>
    </div>
  );

  if (bp === 'mobile') {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader>
            <SheetTitle>{t('orgDashboard.insightHistory.generateCustom')}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">{body}</div>
          <div className="mt-4">{footer}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('orgDashboard.insightHistory.generateCustom')}</DialogTitle>
        </DialogHeader>
        <div className="px-7">{body}</div>
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
