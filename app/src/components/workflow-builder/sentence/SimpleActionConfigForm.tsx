import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { useTranslation } from '../../../lib/i18n';

export interface SimpleActionConfigFormProps {
  action: string;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

type SimpleFieldType = 'text' | 'url' | 'password' | 'select' | 'textarea';

export interface FieldDef {
  key: string;
  labelKey: string;
  placeholderKey?: string;
  type?: SimpleFieldType;
  required?: boolean;
  // Only used when type === 'select'.
  options?: string[];
}

// Minimal single-column config forms for non-content-producing actions
// (BUILDER_REDESIGN_V2_CONCEPT.md §6 — "a couple of relevant text inputs per
// action type is fine"). Explicitly lower priority than ContentCustomizationPanel.
// Exported (not just module-private) so workflowCanvas.ts's `isActionConfigured`
// can reuse the exact same field-completeness definition for the canvas
// builder's configured/unconfigured indicator (DEEP_AUDIT_FIX_SPECS.md Issue 1)
// instead of re-declaring a second, driftable copy of this map.
export const FIELDS_BY_ACTION: Record<string, FieldDef[]> = {
  'data.tag_responses': [
    { key: 'tag', labelKey: 'workflows.builder.sentence.simpleForm.tagLabel', placeholderKey: 'workflows.builder.sentence.simpleForm.tagPlaceholder' },
  ],
  'jira.create_issue': [
    { key: 'projectKey', labelKey: 'workflows.builder.sentence.simpleForm.jiraProjectLabel', placeholderKey: 'workflows.builder.sentence.simpleForm.jiraProjectPlaceholder' },
  ],
  'salesforce.update_contact': [
    { key: 'field', labelKey: 'workflows.builder.sentence.simpleForm.salesforceFieldLabel', placeholderKey: 'workflows.builder.sentence.simpleForm.salesforceFieldPlaceholder' },
  ],
  'servicenow.create_incident': [
    { key: 'category', labelKey: 'workflows.builder.sentence.simpleForm.servicenowCategoryLabel', placeholderKey: 'workflows.builder.sentence.simpleForm.servicenowCategoryPlaceholder' },
  ],
  'zendesk.create_ticket': [
    { key: 'priority', labelKey: 'workflows.builder.sentence.simpleForm.zendeskPriorityLabel', placeholderKey: 'workflows.builder.sentence.simpleForm.zendeskPriorityPlaceholder' },
  ],
  'flow.approval': [
    { key: 'approverEmail', labelKey: 'workflows.builder.sentence.simpleForm.approverLabel', placeholderKey: 'workflows.builder.sentence.simpleForm.approverPlaceholder' },
  ],
  'flow.stop': [],
  // notify.webhook (Maya DEEP_AUDIT_PM_FINDINGS.md 2a, "fix immediately" #2) —
  // a live, fully-wired backend action (workflowEngine.ts's executeAction reads
  // config.url/method/headers/payload/secret directly) that had zero config UI,
  // so every webhook action silently no-op'd forever (`skipped`/`no_url`). Same
  // shape as the Wave 9 notify.in_app fix, different action type.
  'notify.webhook': [
    { key: 'url', labelKey: 'workflows.builder.sentence.simpleForm.webhookUrlLabel', placeholderKey: 'workflows.builder.sentence.simpleForm.webhookUrlPlaceholder', type: 'url', required: true },
    { key: 'method', labelKey: 'workflows.builder.sentence.simpleForm.webhookMethodLabel', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH'] },
    { key: 'headers', labelKey: 'workflows.builder.sentence.simpleForm.webhookHeadersLabel', placeholderKey: 'workflows.builder.sentence.simpleForm.webhookHeadersPlaceholder', type: 'textarea' },
    { key: 'payload', labelKey: 'workflows.builder.sentence.simpleForm.webhookPayloadLabel', placeholderKey: 'workflows.builder.sentence.simpleForm.webhookPayloadPlaceholder', type: 'textarea' },
    { key: 'secret', labelKey: 'workflows.builder.sentence.simpleForm.webhookSecretLabel', placeholderKey: 'workflows.builder.sentence.simpleForm.webhookSecretPlaceholder', type: 'password' },
  ],
};

export function SimpleActionConfigForm({ action, config, onChange }: SimpleActionConfigFormProps) {
  const { t } = useTranslation();
  const fields = FIELDS_BY_ACTION[action] ?? [];

  if (fields.length === 0) {
    return <p className="text-sm text-on-surface-variant">{t('workflows.builder.sentence.simpleForm.noConfigNeeded')}</p>;
  }

  return (
    <div className="space-y-3" data-testid="simple-action-config-form">
      {fields.map((f) => {
        const label = `${t(f.labelKey)}${f.required ? ' *' : ''}`;
        const value = (config[f.key] as string) ?? '';
        if (f.type === 'select') {
          return (
            <div key={f.key} className="space-y-1">
              <Label htmlFor={`simple-${f.key}`}>{label}</Label>
              <Select value={value || f.options?.[0]} onValueChange={(v) => onChange({ ...config, [f.key]: v })}>
                <SelectTrigger id={`simple-${f.key}`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(f.options ?? []).map((opt) => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          );
        }
        if (f.type === 'textarea') {
          return (
            <div key={f.key} className="space-y-1">
              <Label htmlFor={`simple-${f.key}`}>{label}</Label>
              <Textarea
                id={`simple-${f.key}`}
                placeholder={f.placeholderKey ? t(f.placeholderKey) : undefined}
                value={value}
                onChange={(e) => onChange({ ...config, [f.key]: e.target.value })}
                rows={3}
              />
            </div>
          );
        }
        return (
          <div key={f.key} className="space-y-1">
            <Label htmlFor={`simple-${f.key}`}>{label}</Label>
            <Input
              id={`simple-${f.key}`}
              type={f.type === 'url' ? 'url' : f.type === 'password' ? 'password' : 'text'}
              placeholder={f.placeholderKey ? t(f.placeholderKey) : undefined}
              value={value}
              onChange={(e) => onChange({ ...config, [f.key]: e.target.value })}
            />
          </div>
        );
      })}
    </div>
  );
}
