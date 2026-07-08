import { useMemo, useState } from 'react';
import { useTranslation } from '../../../lib/i18n';
import { Icon } from '../../Icon';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import {
  buildCronFromConfig, buildScheduleDescription, getNextRunFromCron,
  type ScheduleConfigState, type Weekday, type ScheduleFrequency,
} from '../../../lib/scheduleConfig';

const WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
const MINUTE_STEPS = [0, 15, 30, 45];

function relativeTime(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `in ${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  return `in ${diffDay}d`;
}

// TS lib target (ES2020) predates the Intl.supportedValuesOf() typing
// (ES2022) even though the runtime API is broadly supported in evergreen
// browsers — narrow ambient declaration (merged into the real global Intl
// namespace, not a shadowing local one) rather than bumping the project-wide
// lib target for one call site.
declare global {
  namespace Intl {
    function supportedValuesOf(input: 'timeZone' | 'calendar' | 'collation' | 'currency' | 'numberingSystem' | 'unit'): string[];
  }
}

function ianaTimezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London'];
  }
}

function tzDisplayLabel(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date());
    const short = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    return `${tz} — ${short}`;
  } catch {
    return tz;
  }
}

export interface ScheduleTriggerConfigPanelProps {
  config: ScheduleConfigState;
  onChange: (config: ScheduleConfigState) => void;
}

export function ScheduleTriggerConfigPanel({ config, onChange }: ScheduleTriggerConfigPanelProps) {
  const { t } = useTranslation();
  const [exactMinute, setExactMinute] = useState(!MINUTE_STEPS.includes(config.time.minute));
  const [tzSearchOpen, setTzSearchOpen] = useState(false);
  const timezones = useMemo(ianaTimezones, []);
  const cron = useMemo(() => buildCronFromConfig(config), [config]);
  const description = useMemo(() => buildScheduleDescription(config), [config]);
  const nextRun = useMemo(() => getNextRunFromCron(cron, config.timezone, new Date(), config), [cron, config]);
  const disabled = config.rawCronOverride != null;

  function patch(p: Partial<ScheduleConfigState>) {
    onChange({ ...config, ...p });
  }

  function setFrequency(freq: ScheduleFrequency) {
    patch({ frequency: freq });
  }

  function toggleWeekday(day: Weekday) {
    const has = config.weeklyDays.includes(day);
    if (has && config.weeklyDays.length === 1) return; // min-1-selected validation
    const next = has ? config.weeklyDays.filter((d) => d !== day) : [...config.weeklyDays, day];
    patch({ weeklyDays: next });
  }

  function setCronOverride(raw: string) {
    patch({ rawCronOverride: raw === '' ? null : raw });
  }

  const cronValidatesAs = config.rawCronOverride != null ? buildScheduleDescription(config) : '';

  return (
    <div className="space-y-5" data-testid="schedule-trigger-config-panel">
      {/* Frequency */}
      <div className="space-y-2">
        <Label>{t('workflows.builder.unified.schedule.frequencyHeading')}</Label>
        <ToggleGroup
          type="single"
          value={config.frequency}
          onValueChange={(v) => v && setFrequency(v as ScheduleFrequency)}
          disabled={disabled}
        >
          <ToggleGroupItem value="daily" aria-label="daily">{t('workflows.builder.unified.schedule.frequencyDaily')}</ToggleGroupItem>
          <ToggleGroupItem value="weekly" aria-label="weekly">{t('workflows.builder.unified.schedule.frequencyWeekly')}</ToggleGroupItem>
          <ToggleGroupItem value="monthly" aria-label="monthly">{t('workflows.builder.unified.schedule.frequencyMonthly')}</ToggleGroupItem>
          <ToggleGroupItem value="custom" aria-label="custom">{t('workflows.builder.unified.schedule.frequencyCustom')}</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Weekly days */}
      {config.frequency === 'weekly' && (
        <div className="space-y-2">
          <Label>{t('workflows.builder.unified.schedule.weeklyDaysHeading')}</Label>
          <ToggleGroup type="multiple" value={config.weeklyDays.map(String)} disabled={disabled}>
            {WEEKDAYS.map((d) => (
              <ToggleGroupItem
                key={d}
                value={String(d)}
                aria-label={`weekday-${d}`}
                onClick={() => toggleWeekday(d)}
              >
                {t(`workflows.builder.unified.schedule.weekdayShort${d}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      )}

      {/* Monthly */}
      {config.frequency === 'monthly' && (
        <div className="space-y-3">
          <Label>{t('workflows.builder.unified.schedule.monthlyVariantHeading')}</Label>
          <RadioGroup
            value={config.monthly.variant}
            onValueChange={(v) => patch({ monthly: { ...config.monthly, variant: v as ScheduleConfigState['monthly']['variant'] } })}
            disabled={disabled}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="day_of_month" id="monthly-dom" />
              <label htmlFor="monthly-dom" className="text-sm">{t('workflows.builder.unified.schedule.monthlyDayOfMonth', { ordinal: `${config.monthly.dayOfMonth ?? 1}` })}</label>
            </div>
            {config.monthly.variant === 'day_of_month' && (
              <div className="ml-6 space-y-1">
                <Select
                  value={String(config.monthly.dayOfMonth ?? 1)}
                  onValueChange={(v) => patch({ monthly: { ...config.monthly, dayOfMonth: Number(v) } })}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                      <SelectItem key={d} value={String(d)}>{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(config.monthly.dayOfMonth ?? 1) >= 29 && (
                  <p className="text-xs text-warning flex items-center gap-1">
                    <Icon name="warning" size={12} />{t('workflows.builder.unified.schedule.monthlySkipWarning')}
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <RadioGroupItem value="ordinal_weekday" id="monthly-ordinal" />
              <label htmlFor="monthly-ordinal" className="text-sm">
                {t('workflows.builder.unified.schedule.monthlyOrdinalWeekday', {
                  ordinal: config.monthly.ordinal ?? 'first',
                  weekday: t(`workflows.builder.unified.schedule.weekdayShort${config.monthly.ordinalWeekday ?? 1}`),
                })}
              </label>
            </div>
            {config.monthly.variant === 'ordinal_weekday' && (
              <div className="ml-6 flex items-center gap-2">
                <Select
                  value={config.monthly.ordinal ?? 'first'}
                  onValueChange={(v) => patch({ monthly: { ...config.monthly, ordinal: v as NonNullable<ScheduleConfigState['monthly']['ordinal']> } })}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="first">{t('workflows.builder.unified.schedule.ordinalFirst')}</SelectItem>
                    <SelectItem value="second">{t('workflows.builder.unified.schedule.ordinalSecond')}</SelectItem>
                    <SelectItem value="third">{t('workflows.builder.unified.schedule.ordinalThird')}</SelectItem>
                    <SelectItem value="fourth">{t('workflows.builder.unified.schedule.ordinalFourth')}</SelectItem>
                    <SelectItem value="last">{t('workflows.builder.unified.schedule.ordinalLast')}</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={String(config.monthly.ordinalWeekday ?? 1)}
                  onValueChange={(v) => patch({ monthly: { ...config.monthly, ordinalWeekday: Number(v) as Weekday } })}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {WEEKDAYS.map((d) => (
                      <SelectItem key={d} value={String(d)}>{t(`workflows.builder.unified.schedule.weekdayShort${d}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-center gap-2">
              <RadioGroupItem value="last_day" id="monthly-last" />
              <label htmlFor="monthly-last" className="text-sm">{t('workflows.builder.unified.schedule.monthlyLastDay')}</label>
            </div>
          </RadioGroup>
        </div>
      )}

      {/* Custom interval */}
      {config.frequency === 'custom' && (
        <div className="space-y-2">
          <Label>{t('workflows.builder.unified.schedule.customIntervalHeading')}</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number" min={1} max={365} className="w-20"
              value={config.customInterval.count}
              disabled={disabled}
              onChange={(e) => patch({ customInterval: { ...config.customInterval, count: Math.max(1, Math.min(365, Number(e.target.value) || 1)) } })}
            />
            <Select
              value={config.customInterval.unit}
              onValueChange={(v) => patch({ customInterval: { ...config.customInterval, unit: v as ScheduleConfigState['customInterval']['unit'] } })}
              disabled={disabled}
            >
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="hours">{t('workflows.builder.unified.schedule.customIntervalUnitHours')}</SelectItem>
                <SelectItem value="days">{t('workflows.builder.unified.schedule.customIntervalUnitDays')}</SelectItem>
                <SelectItem value="weeks">{t('workflows.builder.unified.schedule.customIntervalUnitWeeks')}</SelectItem>
                <SelectItem value="months">{t('workflows.builder.unified.schedule.customIntervalUnitMonths')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {config.customInterval.unit === 'weeks' && (
            <div className="flex items-center gap-2">
              <Label className="text-xs">{t('workflows.builder.unified.schedule.startingFromLabel')}</Label>
              <Select
                value={String(config.customInterval.startingWeekday ?? 1)}
                onValueChange={(v) => patch({ customInterval: { ...config.customInterval, startingWeekday: Number(v) as Weekday } })}
                disabled={disabled}
              >
                <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WEEKDAYS.map((d) => (
                    <SelectItem key={d} value={String(d)}>{t(`workflows.builder.unified.schedule.weekdayShort${d}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      {/* Time of day */}
      <div className="space-y-2">
        <Label>{t('workflows.builder.unified.schedule.timeHeading')}</Label>
        <div className="flex items-center gap-2">
          <Select
            value={String(config.time.hour12)}
            onValueChange={(v) => patch({ time: { ...config.time, hour12: Number(v) } })}
            disabled={disabled}
          >
            <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => <SelectItem key={h} value={String(h)}>{h}</SelectItem>)}
            </SelectContent>
          </Select>

          {exactMinute ? (
            <Select
              value={String(config.time.minute)}
              onValueChange={(v) => patch({ time: { ...config.time, minute: Number(v) } })}
              disabled={disabled}
            >
              <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: 60 }, (_, i) => i).map((m) => <SelectItem key={m} value={String(m)}>{String(m).padStart(2, '0')}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : (
            <Select
              value={String(config.time.minute)}
              onValueChange={(v) => patch({ time: { ...config.time, minute: Number(v) } })}
              disabled={disabled}
            >
              <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MINUTE_STEPS.map((m) => <SelectItem key={m} value={String(m)}>{String(m).padStart(2, '0')}</SelectItem>)}
              </SelectContent>
            </Select>
          )}

          <ToggleGroup
            type="single"
            value={config.time.meridiem}
            onValueChange={(v) => v && patch({ time: { ...config.time, meridiem: v as 'AM' | 'PM' } })}
            disabled={disabled}
          >
            <ToggleGroupItem value="AM" aria-label="AM">AM</ToggleGroupItem>
            <ToggleGroupItem value="PM" aria-label="PM">PM</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <button
          type="button"
          className="text-xs text-primary font-semibold hover:underline"
          onClick={() => setExactMinute((v) => !v)}
          disabled={disabled}
        >
          {exactMinute ? t('workflows.builder.unified.schedule.useDefaultMinutes') : t('workflows.builder.unified.schedule.pickExactMinute')}
        </button>
      </div>

      {/* Timezone */}
      <div className="space-y-2">
        <Label>{t('workflows.builder.unified.schedule.timezoneHeading')}</Label>
        <RadioGroup
          value={config.useBrowserTimezone ? 'browser' : 'choose'}
          onValueChange={(v) => patch({ useBrowserTimezone: v === 'browser' })}
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="browser" id="tz-browser" />
            <label htmlFor="tz-browser" className="text-sm">{t('workflows.builder.unified.schedule.useBrowserTimezone')}</label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="choose" id="tz-choose" />
            <label htmlFor="tz-choose" className="text-sm">{t('workflows.builder.unified.schedule.chooseTimezone')}</label>
          </div>
        </RadioGroup>
        <Popover open={tzSearchOpen} onOpenChange={setTzSearchOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={config.useBrowserTimezone}
              className="w-full text-left text-sm border border-border rounded-lg px-3 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {tzDisplayLabel(config.timezone)}
            </button>
          </PopoverTrigger>
          <PopoverContent className="p-0 w-72">
            <Command>
              <CommandInput placeholder={t('workflows.builder.unified.schedule.timezoneSearchPlaceholder')} />
              <CommandList>
                <CommandEmpty>{t('workflows.builder.unified.schedule.timezoneEmpty')}</CommandEmpty>
                <CommandGroup>
                  {timezones.map((tz) => (
                    <CommandItem
                      key={tz}
                      value={tz}
                      onSelect={() => { patch({ timezone: tz }); setTzSearchOpen(false); }}
                    >
                      {tzDisplayLabel(tz)}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {/* Live preview */}
      <div className="rounded-xl bg-muted/40 p-3 space-y-1" data-testid="schedule-preview">
        <p className="text-sm font-semibold text-on-surface capitalize">{description}</p>
        <p className="text-xs text-on-surface-variant">
          {nextRun
            ? t('workflows.builder.unified.schedule.previewNextRun', { when: `${nextRun.toLocaleString()} · ${relativeTime(nextRun)}` })
            : t('workflows.builder.unified.schedule.previewNextRunUnknown')}
        </p>
      </div>

      {/* Developer mode */}
      <Collapsible open={config.developerMode} onOpenChange={(open) => patch({ developerMode: open })}>
        <CollapsibleTrigger asChild>
          <button type="button" className="flex items-center gap-1 text-xs font-semibold text-on-surface-variant hover:text-on-surface">
            <Icon name={config.developerMode ? 'expand_less' : 'expand_more'} size={14} />
            {t('workflows.builder.unified.schedule.developerMode')}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3 space-y-2">
          <Label htmlFor="cron-input">{t('workflows.builder.unified.schedule.cronLabel')}</Label>
          <Input
            id="cron-input"
            value={config.rawCronOverride ?? ''}
            placeholder={t('workflows.builder.unified.schedule.cronPlaceholder')}
            onChange={(e) => setCronOverride(e.target.value)}
          />
          {config.rawCronOverride != null && (
            <p className="text-xs text-on-surface-variant">
              {t('workflows.builder.unified.schedule.cronValidatesAs', { description: cronValidatesAs })}
            </p>
          )}
          <p className="text-xs text-on-surface-variant">{t('workflows.builder.unified.schedule.cronHelp')}</p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
