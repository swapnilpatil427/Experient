import { useTranslation } from '../../../lib/i18n';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import {
  SECTION_KEYS, sectionsForPreset, matchingPreset,
  type SectionState, type SectionPreset,
} from './contentSections';

export interface SectionChecklistProps {
  sections: SectionState;
  preset: SectionPreset;
  onChange: (sections: SectionState, preset: SectionPreset) => void;
}

const SECTION_LABEL_KEYS: Record<keyof SectionState, string> = {
  crystalSummary: 'workflows.builder.sentence.content.sectionCrystalSummary',
  keyMetrics: 'workflows.builder.sentence.content.sectionKeyMetrics',
  topVerbatims: 'workflows.builder.sentence.content.sectionTopVerbatims',
  trendChart: 'workflows.builder.sentence.content.sectionTrendChart',
  recommendedActions: 'workflows.builder.sentence.content.sectionRecommendedActions',
  rawResponseCount: 'workflows.builder.sentence.content.sectionRawResponseCount',
};

// Left column of ContentCustomizationPanel — preset dropdown + individually
// toggleable checkboxes. Crystal AI Summary is deliberately NOT locked/disabled
// (BUILDER_REDESIGN_V2_CONCEPT.md §5 — this is the direct fix for "what if I
// don't want crystal summary"). Editing any single checkbox after choosing a
// preset silently flips the preset display to "Custom".
export function SectionChecklist({ sections, preset, onChange }: SectionChecklistProps) {
  const { t } = useTranslation();

  function handlePresetChange(value: string) {
    if (value === 'custom') return; // "Custom" isn't a settable target, it's a derived display state
    const next = sectionsForPreset(value as Exclude<SectionPreset, 'custom'>);
    onChange(next, value as SectionPreset);
  }

  function toggle(key: keyof SectionState) {
    const next = { ...sections, [key]: !sections[key] };
    onChange(next, matchingPreset(next));
  }

  return (
    <div className="space-y-4" data-testid="section-checklist">
      <div className="space-y-1.5">
        <Label>{t('workflows.builder.sentence.content.presetLabel')}</Label>
        <Select value={preset} onValueChange={handlePresetChange}>
          <SelectTrigger data-testid="section-preset-select"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="standard">{t('workflows.builder.sentence.content.presetStandard')}</SelectItem>
            <SelectItem value="metricsOnly">{t('workflows.builder.sentence.content.presetMetricsOnly')}</SelectItem>
            <SelectItem value="fullDetail">{t('workflows.builder.sentence.content.presetFullDetail')}</SelectItem>
            <SelectItem value="custom" disabled>{t('workflows.builder.sentence.content.presetCustom')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        {SECTION_KEYS.map((key) => (
          <label key={key} className="flex items-center gap-2.5 cursor-pointer" htmlFor={`section-${key}`}>
            <Checkbox
              id={`section-${key}`}
              data-testid={`section-checkbox-${key}`}
              checked={sections[key]}
              onCheckedChange={() => toggle(key)}
            />
            <span className="text-sm text-on-surface">{t(SECTION_LABEL_KEYS[key])}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
