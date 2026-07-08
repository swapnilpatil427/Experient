import { useState } from 'react';
import { useTranslation } from '../../../lib/i18n';
import { Icon } from '../../Icon';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { suggestedCooldownMinutes } from '../../../lib/triggerGroups';

const PRESETS = [0, 15, 30, 60, 240, 1440] as const;

export interface WorkflowSettingsPanelProps {
  cooldownMinutes: number | null;
  onChange: (minutes: number | null) => void;
  triggerType?: string | null;
}

function presetKey(minutes: number): string {
  switch (minutes) {
    case 0: return 'workflows.builder.unified.settings.cooldownNone';
    case 15: return 'workflows.builder.unified.settings.cooldown15';
    case 30: return 'workflows.builder.unified.settings.cooldown30';
    case 60: return 'workflows.builder.unified.settings.cooldown60';
    case 240: return 'workflows.builder.unified.settings.cooldown240';
    case 1440: return 'workflows.builder.unified.settings.cooldown1440';
    default: return '';
  }
}

export function WorkflowSettingsPanel({ cooldownMinutes, onChange, triggerType }: WorkflowSettingsPanelProps) {
  const { t } = useTranslation();
  const suggestion = suggestedCooldownMinutes(triggerType);
  const notApplicable = suggestion === 'not_applicable';

  const isPreset = cooldownMinutes != null && (PRESETS as readonly number[]).includes(cooldownMinutes);
  // Selecting "Custom" from a preset value is a deliberate mode switch, not
  // just a derived read of the current number — without tracking intent
  // separately, choosing Custom while the value happens to coincide with a
  // preset (most commonly landing on 0/"No cooldown" the instant Custom is
  // selected with an empty input) would immediately snap the radio group
  // back to that preset, making "Custom" unselectable in the UI. This local
  // flag is reset whenever an incoming cooldownMinutes prop is an explicit
  // non-preset value (i.e. after a real save/reload round-trip).
  const [customModeIntent, setCustomModeIntent] = useState(false);
  const radioValue = notApplicable
    ? 'not_applicable'
    : cooldownMinutes == null
      ? 'custom'
      : isPreset ? (customModeIntent ? 'custom' : String(cooldownMinutes)) : 'custom';
  const customValue = radioValue === 'custom' && cooldownMinutes != null ? cooldownMinutes : '';

  function handleRadioChange(v: string) {
    if (v === 'custom') {
      setCustomModeIntent(true);
    } else {
      setCustomModeIntent(false);
      onChange(Number(v));
    }
  }

  function handleCustomInputChange(raw: string) {
    setCustomModeIntent(true);
    onChange(raw === '' ? null : Number(raw));
  }

  return (
    <div className="space-y-4" data-testid="workflow-settings-panel">
      <p className="text-sm font-bold text-on-surface uppercase tracking-wide">{t('workflows.builder.unified.settings.heading')}</p>

      <div className="space-y-2">
        <p className="text-sm font-semibold text-on-surface">{t('workflows.builder.unified.settings.cooldownHeading')}</p>
        <p className="text-xs text-on-surface-variant">{t('workflows.builder.unified.settings.cooldownDescription')}</p>

        {notApplicable ? (
          <p className="text-xs text-on-surface-variant italic" data-testid="cooldown-not-applicable">
            {t('workflows.builder.unified.settings.cooldownNotApplicable')} — {t('workflows.builder.unified.settings.cooldownScheduleNote')}
          </p>
        ) : (
          <RadioGroup value={radioValue} onValueChange={handleRadioChange} data-testid="cooldown-radio-group">
            {PRESETS.map((p) => (
              <div key={p} className="flex items-center gap-2">
                <RadioGroupItem value={String(p)} id={`cooldown-${p}`} />
                <label htmlFor={`cooldown-${p}`} className="text-sm">{t(presetKey(p))}</label>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <RadioGroupItem value="custom" id="cooldown-custom" />
              <label htmlFor="cooldown-custom" className="text-sm">{t('workflows.builder.unified.settings.cooldownCustom')}:</label>
              <Input
                type="number" min={0} className="w-20 h-8"
                disabled={radioValue !== 'custom'}
                value={customValue}
                onChange={(e) => handleCustomInputChange(e.target.value)}
              />
              <span className="text-xs text-on-surface-variant">{t('workflows.builder.unified.settings.cooldownCustomUnit')}</span>
            </div>
          </RadioGroup>
        )}
      </div>

      <div className="rounded-lg bg-muted/40 p-3 text-xs text-on-surface-variant space-y-1">
        <p className="flex items-center gap-1 font-semibold"><Icon name="info" size={13} />{t('workflows.builder.unified.settings.suggestedHeading')}</p>
        <p>{t('workflows.builder.unified.settings.suggestedAlerts')} {t('workflows.builder.unified.settings.suggestedAlertsValue')}</p>
        <p>{t('workflows.builder.unified.settings.suggestedThemes')} {t('workflows.builder.unified.settings.suggestedThemesValue')}</p>
        <p>{t('workflows.builder.unified.settings.suggestedEvents')} {t('workflows.builder.unified.settings.suggestedEventsValue')}</p>
        <p>{t('workflows.builder.unified.settings.suggestedScheduled')} {t('workflows.builder.unified.settings.suggestedScheduledValue')}</p>
      </div>

      <Collapsible>
        <CollapsibleTrigger asChild>
          <button type="button" className="flex items-center gap-1 text-xs font-semibold text-on-surface-variant hover:text-on-surface">
            <Icon name="expand_more" size={14} />
            {t('workflows.builder.unified.rightPanel.canvasTipsHeading')}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 space-y-1 text-xs text-on-surface-variant">
          <p>• {t('workflows.builder.unified.rightPanel.canvasTip1')}</p>
          <p>• {t('workflows.builder.unified.rightPanel.canvasTip2')}</p>
          <p>• {t('workflows.builder.unified.rightPanel.canvasTip3')}</p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
