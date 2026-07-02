import { useTranslation } from '../../../lib/i18n';
import { TRIGGER_GROUPS, TRIGGER_GROUP_ORDER, type TriggerGroupKey } from '../../../lib/triggerGroups';
import { TriggerTile } from './TriggerTile';
import { triggerDescription } from './triggerDescriptions';
import { ScheduleTriggerConfigPanel } from '../panels/ScheduleTriggerConfigPanel';
import type { ScheduleConfigState } from '../../../lib/scheduleConfig';

export interface TriggerOption { type: string; label: string; category: string; live?: boolean }

export interface TriggerStepPanelContentProps {
  triggers: TriggerOption[];
  selectedType?: string;
  onSelect: (type: string) => void;
  scheduleConfig?: ScheduleConfigState;
  onScheduleChange: (config: ScheduleConfigState) => void;
}

const GROUP_LABEL_KEYS: Record<TriggerGroupKey, string> = {
  alerts: 'workflows.builder.unified.palette.groups.alerts',
  thresholds: 'workflows.builder.unified.palette.groups.thresholds',
  aiSignals: 'workflows.builder.unified.palette.groups.aiSignals',
  scheduled: 'workflows.builder.unified.palette.groups.scheduled',
  events: 'workflows.builder.unified.palette.groups.events',
};

// Trigger step-panel body — tile grid grouped by triggerGroups.ts's 5
// categories (reused DATA, not visual treatment, per Wave 6 briefing).
// Selecting time.schedule reveals the reused ScheduleTriggerConfigPanel
// beneath the grid, tile grid stays visible/pinned (concept §4).
export function TriggerStepPanelContent({
  triggers, selectedType, onSelect, scheduleConfig, onScheduleChange,
}: TriggerStepPanelContentProps) {
  const { t } = useTranslation();
  const labelFor = (type: string) => triggers.find((tr) => tr.type === type)?.label ?? type;
  const liveFor = (type: string) => triggers.find((tr) => tr.type === type)?.live;

  return (
    <div className="space-y-6" data-testid="trigger-step-panel-content">
      {TRIGGER_GROUP_ORDER.map((groupKey) => {
        const members = TRIGGER_GROUPS[groupKey].filter((m) => triggers.some((tr) => tr.type === m.type));
        if (members.length === 0) return null;
        return (
          <div key={groupKey} data-testid={`trigger-tile-group-${groupKey}`}>
            <p className="label-caps mb-3">{t(GROUP_LABEL_KEYS[groupKey])}</p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {members.map((m) => (
                <TriggerTile
                  key={m.type}
                  type={m.type}
                  label={labelFor(m.type)}
                  description={triggerDescription(m.type)}
                  icon={m.icon}
                  isCrystal={m.isCrystal}
                  selected={selectedType === m.type}
                  onSelect={() => onSelect(m.type)}
                  live={liveFor(m.type)}
                />
              ))}
            </div>
          </div>
        );
      })}

      {selectedType === 'time.schedule' && scheduleConfig && (
        <div className="pt-4 border-t border-border">
          <p className="label-caps mb-3">{t('workflows.builder.sentence.trigger.scheduleHeading')}</p>
          <ScheduleTriggerConfigPanel config={scheduleConfig} onChange={onScheduleChange} />
        </div>
      )}
    </div>
  );
}
