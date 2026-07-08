import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Icon } from '../../Icon';
import { useTranslation } from '../../../lib/i18n';
import { NotifyTargetPicker } from './NotifyTargetPicker';
import type { NotifyTarget } from '../../../lib/api';

export interface AdvancedFieldsValue {
  target?: NotifyTarget;
  channel?: string;
  subject?: string;
}

export interface AdvancedFieldsDisclosureProps {
  actionType: string;
  value: AdvancedFieldsValue;
  onChange: (value: AdvancedFieldsValue) => void;
}

// Collapsed-by-default plumbing fields — subject line template / channel name
// / (Wave 9) recipient targeting — same Collapsible pattern as
// ScheduleTriggerConfigPanel.tsx's developer-mode section. The free-text
// `recipients` field notify.email used to have here was dead code (never
// serialized, and the backend only ever read a single hardcoded userId) — see
// docs/automation-hub/TEMPLATE_FLOW_AND_RECIPIENT_TARGETING_SPEC.md §Issue 2.
// Replaced entirely by NotifyTargetPicker, which also backs notify.in_app's
// config (wired separately in ActionStepPanelContent.tsx, since notify.in_app
// isn't a CONTENT_PRODUCING_ACTION and doesn't go through this disclosure).
export function AdvancedFieldsDisclosure({ actionType, value, onChange }: AdvancedFieldsDisclosureProps) {
  const { t } = useTranslation();
  const isEmail = actionType === 'notify.email';
  const isSlack = actionType === 'notify.slack';

  if (!isEmail && !isSlack) return null;

  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <button type="button" className="flex items-center gap-1 text-xs font-semibold text-on-surface-variant hover:text-on-surface">
          <Icon name="expand_more" size={14} />
          {t('workflows.builder.sentence.content.advancedFieldsHeading')}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3 space-y-3">
        {isEmail && (
          <>
            <div className="space-y-1">
              <Label>{t('workflows.builder.sentence.notifyTarget.heading')}</Label>
              <NotifyTargetPicker
                value={value.target}
                onChange={(target) => onChange({ ...value, target })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="adv-subject">{t('workflows.builder.sentence.content.subjectLabel')}</Label>
              <Input
                id="adv-subject"
                placeholder={t('workflows.builder.sentence.content.subjectPlaceholder')}
                value={value.subject ?? ''}
                onChange={(e) => onChange({ ...value, subject: e.target.value })}
              />
            </div>
          </>
        )}
        {isSlack && (
          <div className="space-y-1">
            <Label htmlFor="adv-channel">{t('workflows.builder.sentence.content.channelLabel')}</Label>
            <Input
              id="adv-channel"
              placeholder={t('workflows.builder.sentence.content.channelPlaceholder')}
              value={value.channel ?? ''}
              onChange={(e) => onChange({ ...value, channel: e.target.value })}
            />
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
