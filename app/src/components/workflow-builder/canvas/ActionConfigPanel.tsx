// Canvas builder's per-action config side-sheet (DEEP_AUDIT_FIX_SPECS.md
// Issue 1). NOT a re-skin of StepPanel — StepPanel is purpose-built for the
// sentence builder's linear step-sequencing UX (Cancel/Done wired to that
// page's step-navigation state machine). The canvas has a different
// interaction shape: N independently-editable action nodes, no "steps" — so
// this is a right-side Sheet (an existing shadcn primitive, zero new
// dependency) with live-patched edits and no separate Cancel (nothing to
// discard — see the Sheet chrome note below).
//
// Body dispatch is the exact same three-way branch ActionStepPanelContent.tsx
// already encodes — imported, not re-declared:
//   CONTENT_PRODUCING_ACTIONS.has(action) -> ContentCustomizationPanel
//   action === 'notify.in_app'            -> NotifyTargetPicker
//   else                                  -> SimpleActionConfigForm
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useTranslation } from '../../../lib/i18n';
import { ContentCustomizationPanel, CONTENT_PRODUCING_ACTIONS } from '../sentence/ContentCustomizationPanel';
import { SimpleActionConfigForm } from '../sentence/SimpleActionConfigForm';
import { NotifyTargetPicker } from '../sentence/NotifyTargetPicker';
import {
  defaultActionContentConfig, extractNotifyTarget, flattenNotifyTarget, type ActionContentConfig,
} from '../sentence/contentSections';

const IN_APP_NOTIFY_ACTION = 'notify.in_app';

export interface ActionConfigPanelProps {
  open: boolean;
  action: string;
  actionLabel: string;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  onClose: () => void;
}

// Adapter: canvas/engine's flat `Record<string, unknown>` config <->
// ContentCustomizationPanel's richer `ActionContentConfig` shape. The
// sentence builder already solves exactly this impedance mismatch
// (WorkflowBuilderPage.tsx's serialize()/hydrateFromNodes()) — this mirrors
// that pattern rather than inventing a new one.
function toActionContentConfig(config: Record<string, unknown>): ActionContentConfig {
  const hasContentShape = config.sections != null;
  if (!hasContentShape) return { ...defaultActionContentConfig(), target: extractNotifyTarget(config) };
  return { ...(config as unknown as ActionContentConfig), target: extractNotifyTarget(config) };
}

function fromActionContentConfig(value: ActionContentConfig): Record<string, unknown> {
  const { target, ...rest } = value;
  return { ...rest, ...flattenNotifyTarget(target) };
}

export function ActionConfigPanel({ open, action, actionLabel, config, onChange, onClose }: ActionConfigPanelProps) {
  const { t } = useTranslation();
  const isContentProducing = CONTENT_PRODUCING_ACTIONS.has(action);
  const isInAppNotify = action === IN_APP_NOTIFY_ACTION;

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent data-testid="action-config-panel">
        <SheetHeader>
          <SheetTitle>{actionLabel}</SheetTitle>
        </SheetHeader>
        <div className="mt-4">
          {isContentProducing ? (
            <ContentCustomizationPanel
              actionType={action}
              value={toActionContentConfig(config)}
              onChange={(next) => onChange(fromActionContentConfig(next))}
            />
          ) : isInAppNotify ? (
            <div className="space-y-1">
              <Label>{t('workflows.builder.sentence.notifyTarget.heading')}</Label>
              <NotifyTargetPicker
                value={extractNotifyTarget(config)}
                onChange={(target) => onChange({ ...config, ...flattenNotifyTarget(target) })}
              />
            </div>
          ) : (
            <SimpleActionConfigForm action={action} config={config} onChange={onChange} />
          )}
        </div>
        <div className="mt-6 flex justify-end">
          <Button type="button" variant="default" onClick={onClose}>
            {t('workflows.canvas.actionNode.panelDone')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
