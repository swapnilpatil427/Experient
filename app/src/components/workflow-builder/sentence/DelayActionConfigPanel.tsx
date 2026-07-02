import { useMemo } from 'react';
import { useTranslation, t as translate } from '../../../lib/i18n';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';

// flow.delay's config UI (Wave 11, Rohan Desai — docs/automation-hub/
// WAVE11_UX_SPECS.md §2.1). A friendly, unit-aware duration input ("Wait for
// [2] [Hours]") that converts to the engine's `delay_minutes` wire field only
// at serialize time (WorkflowBuilderPage.tsx's buildDelayNodeConfig) — this
// component's own state (`DelayConfigState`) is a UI-only convenience shape,
// same round-trip precedent as `ScheduleConfigState`/`cron`.
export type DelayUnit = 'minutes' | 'hours' | 'days';

export interface DelayConfigState {
  amount: number;
  unit: DelayUnit;
}

export interface DelayActionConfigPanelProps {
  value: DelayConfigState;
  onChange: (value: DelayConfigState) => void;
}

// Soft UI guardrails (not engine limits — the backend enforces its own
// ceiling independently) so a customer can't produce a nonsensical raw
// delay_minutes value from the friendly input.
const UNIT_MAX: Record<DelayUnit, number> = { minutes: 1440, hours: 720, days: 90 };
const UNIT_TO_MINUTES: Record<DelayUnit, number> = { minutes: 1, hours: 60, days: 1440 };

// Unit switch preserves intent (the underlying total duration), not the raw
// number — switching "2 hours" to minutes must show "120", not "2" (a
// 120x-smaller, silently wrong delay).
export function clampDelayAmount(amount: number, unit: DelayUnit, fromUnit?: DelayUnit): number {
  const totalMinutes = fromUnit ? amount * UNIT_TO_MINUTES[fromUnit] : amount * UNIT_TO_MINUTES[unit];
  const converted = fromUnit ? Math.round(totalMinutes / UNIT_TO_MINUTES[unit]) : amount;
  return Math.max(1, Math.min(UNIT_MAX[unit], converted));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function buildDelayPreview(v: DelayConfigState, t: typeof translate): string {
  const key = `workflows.builder.sentence.simpleForm.delayUnit${capitalize(v.unit)}${v.amount === 1 ? 'One' : 'Other'}`;
  const unitLabel = t(key, { count: v.amount });
  return t('workflows.builder.sentence.simpleForm.delayPreview', { duration: unitLabel });
}

export function defaultDelayConfig(): DelayConfigState {
  // 1 hour, not 1 minute — matches the audit's own "if unresolved after 24
  // hours" example; a 1-minute default reads as a placeholder/mistake.
  return { amount: 1, unit: 'hours' };
}

// Converts a saved `delay_minutes` (the engine's only required field) back
// into the friendliest unit — used by hydrateFromNodes() when a flow.delay
// node has no `delayUiState` yet (e.g. created directly via API).
export function minutesToUiState(minutes: number | undefined): DelayConfigState {
  const m = typeof minutes === 'number' && minutes > 0 ? minutes : 60;
  if (m % 1440 === 0) return { amount: m / 1440, unit: 'days' };
  if (m % 60 === 0) return { amount: m / 60, unit: 'hours' };
  return { amount: m, unit: 'minutes' };
}

export function DelayActionConfigPanel({ value, onChange }: DelayActionConfigPanelProps) {
  const { t } = useTranslation();
  const previewText = useMemo(() => buildDelayPreview(value, t), [value, t]);

  return (
    <div className="space-y-3" data-testid="delay-action-config-panel">
      <Label htmlFor="delay-amount">{t('workflows.builder.sentence.simpleForm.delayLabel')}</Label>
      <div className="flex items-center gap-2">
        <Input
          id="delay-amount"
          type="number"
          min={1}
          max={UNIT_MAX[value.unit]}
          className="w-24"
          value={value.amount}
          onChange={(e) => onChange({ ...value, amount: clampDelayAmount(Number(e.target.value) || 1, value.unit) })}
        />
        <Select
          value={value.unit}
          onValueChange={(u) => onChange({ unit: u as DelayUnit, amount: clampDelayAmount(value.amount, u as DelayUnit, value.unit) })}
        >
          <SelectTrigger className="w-32" data-testid="delay-unit-select"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="minutes">{t('workflows.builder.sentence.simpleForm.delayUnitMinutes')}</SelectItem>
            <SelectItem value="hours">{t('workflows.builder.sentence.simpleForm.delayUnitHours')}</SelectItem>
            <SelectItem value="days">{t('workflows.builder.sentence.simpleForm.delayUnitDays')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Live preview — same "rounded-xl bg-muted/40 p-3" treatment as
          ScheduleTriggerConfigPanel's #schedule-preview block. */}
      <div className="rounded-xl bg-muted/40 p-3" data-testid="delay-preview">
        <p className="text-sm font-semibold text-on-surface">{previewText}</p>
      </div>
    </div>
  );
}
