import { SectionChecklist } from './SectionChecklist';
import { LivePreviewMock } from './LivePreviewMock';
import { AdvancedFieldsDisclosure } from './AdvancedFieldsDisclosure';
import type { ActionContentConfig } from './contentSections';

export interface ContentCustomizationPanelProps {
  actionType: string;
  value: ActionContentConfig;
  onChange: (value: ActionContentConfig) => void;
}

export const CONTENT_PRODUCING_ACTIONS = new Set(['notify.email', 'notify.slack', 'crystal.summarize']);

// Two-column content-customization sub-panel (BUILDER_REDESIGN_V2_CONCEPT.md
// §5/§7 component #6) — checklist left, live preview right, advanced fields
// collapsed below both. Collapses to stacked on mobile/tablet.
export function ContentCustomizationPanel({ actionType, value, onChange }: ContentCustomizationPanelProps) {
  return (
    <div className="space-y-4" data-testid="content-customization-panel">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SectionChecklist
          sections={value.sections}
          preset={value.preset}
          onChange={(sections, preset) => onChange({ ...value, sections, preset })}
        />
        <LivePreviewMock actionType={actionType} sections={value.sections} />
      </div>
      <AdvancedFieldsDisclosure
        actionType={actionType}
        value={{ target: value.target, channel: value.channel, subject: value.subject }}
        onChange={(fields) => onChange({ ...value, ...fields })}
      />
    </div>
  );
}
