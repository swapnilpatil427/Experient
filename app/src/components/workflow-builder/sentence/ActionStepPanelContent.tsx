import { Link } from 'react-router-dom';
import { useTranslation } from '../../../lib/i18n';
import { Label } from '@/components/ui/label';
import { Icon } from '../../Icon';
import { ActionTile } from './ActionTile';
import { ContentCustomizationPanel, CONTENT_PRODUCING_ACTIONS } from './ContentCustomizationPanel';
import { SimpleActionConfigForm } from './SimpleActionConfigForm';
import { NotifyTargetPicker } from './NotifyTargetPicker';
import { DelayActionConfigPanel, defaultDelayConfig, type DelayConfigState } from './DelayActionConfigPanel';
import type { ActionContentConfig } from './contentSections';
import { connectorForAction, type CredentialStatus } from '../../../lib/workflowConnectorStatus';
import { ROUTES } from '../../../constants/routes';

// notify.in_app has no "content" to customize (no sections/preset/subject —
// it's a one-line in-app ping, not a digest), so it deliberately isn't a
// CONTENT_PRODUCING_ACTION and doesn't get ContentCustomizationPanel's
// sections-checklist/live-preview UI. It DOES need the same recipient
// targeting notify.email needs (Wave 9) — rather than inventing a second
// config-form path, its `target` is still carried on the shared
// `contentConfig.target` field (see contentSections.ts) so the same
// serialize()/hydrateFromNodes() plumbing in WorkflowBuilderPage.tsx handles
// both actions identically; only the rendered UI differs here.
const IN_APP_NOTIFY_ACTION = 'notify.in_app';

// flow.delay (Wave 11, Rohan WAVE11_UX_SPECS.md §2.4) — its own structured
// config component (amount + unit + live preview), not a SimpleActionConfigForm
// field list, so it needs a fourth branch in the dispatch below alongside
// isContentProducing/isInAppNotify.
const DELAY_ACTION = 'flow.delay';

export interface ActionOption { action: string; label: string; category: string; live: boolean | 'stub' | 'env' }

export interface ActionStepPanelContentProps {
  actions: ActionOption[];
  selectedAction?: string;
  onSelect: (action: string) => void;
  contentConfig: ActionContentConfig;
  onContentConfigChange: (config: ActionContentConfig) => void;
  simpleConfig: Record<string, unknown>;
  onSimpleConfigChange: (config: Record<string, unknown>) => void;
  // Real per-org connector credential status (Kenji finding 1 / Maya 6c /
  // Rohan I-1) keyed by action string — e.g. { 'jira.create_issue':
  // 'disconnected' }. Only populated for connector-backed actions; absent
  // entries fall back to the registry's static `live` tier. Optional so
  // existing callers that haven't wired GET /api/workflow-credentials through
  // yet still compile.
  credentialStatusByAction?: Record<string, CredentialStatus>;
}

const CATEGORY_ORDER = ['Notify', 'Data', 'Crystal', 'Integration', 'Flow'];

// Action step-panel body — tile grid grouped by the registry's own `category`
// field (no separate grouping file needed, per Wave 6 briefing). Selecting a
// content-producing action opens ContentCustomizationPanel; everything else
// gets a minimal single-column SimpleActionConfigForm.
export function ActionStepPanelContent({
  actions, selectedAction, onSelect, contentConfig, onContentConfigChange, simpleConfig, onSimpleConfigChange,
  credentialStatusByAction,
}: ActionStepPanelContentProps) {
  const { t } = useTranslation();
  const categories = CATEGORY_ORDER.filter((cat) => actions.some((a) => a.category === cat));
  const isContentProducing = selectedAction ? CONTENT_PRODUCING_ACTIONS.has(selectedAction) : false;
  const isInAppNotify = selectedAction === IN_APP_NOTIFY_ACTION;
  const isDelay = selectedAction === DELAY_ACTION;
  const selectedIsDisconnected = Boolean(
    selectedAction && connectorForAction(selectedAction) && credentialStatusByAction?.[selectedAction] === 'disconnected',
  );

  return (
    <div className="space-y-6" data-testid="action-step-panel-content">
      {categories.map((category) => (
        <div key={category} data-testid={`action-tile-group-${category}`}>
          <p className="label-caps mb-3">{category}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {actions.filter((a) => a.category === category).map((a) => (
              <ActionTile
                key={a.action}
                action={a.action}
                label={a.label}
                live={a.live}
                credentialStatus={credentialStatusByAction?.[a.action]}
                selected={selectedAction === a.action}
                onSelect={() => onSelect(a.action)}
              />
            ))}
          </div>
        </div>
      ))}

      {selectedAction && (
        <div className="pt-4 border-t border-border">
          <p className="label-caps mb-3">{t('workflows.builder.sentence.action.configureHeading')}</p>
          {selectedIsDisconnected && (
            <div
              data-testid="action-disconnected-banner"
              className="flex items-center gap-2 px-3 py-2.5 mb-3 rounded-xl text-sm bg-error/10 text-error"
            >
              <Icon name="link_off" size={16} className="shrink-0" />
              <span className="flex-1">{t('workflows.builder.sentence.action.disconnectedBannerText')}</span>
              <Link to={ROUTES.SETTINGS_INTEGRATIONS} className="font-semibold underline whitespace-nowrap">
                {t('workflows.builder.sentence.action.disconnectedBannerLink')}
              </Link>
            </div>
          )}
          {isContentProducing ? (
            <ContentCustomizationPanel actionType={selectedAction} value={contentConfig} onChange={onContentConfigChange} />
          ) : isInAppNotify ? (
            <div className="space-y-1">
              <Label>{t('workflows.builder.sentence.notifyTarget.heading')}</Label>
              <NotifyTargetPicker
                value={contentConfig.target}
                onChange={(target) => onContentConfigChange({ ...contentConfig, target })}
              />
            </div>
          ) : isDelay ? (
            <DelayActionConfigPanel
              value={(simpleConfig as { delayUiState?: DelayConfigState }).delayUiState ?? defaultDelayConfig()}
              onChange={(delayUiState) => onSimpleConfigChange({ ...simpleConfig, delayUiState })}
            />
          ) : (
            <SimpleActionConfigForm action={selectedAction} config={simpleConfig} onChange={onSimpleConfigChange} />
          )}
        </div>
      )}
    </div>
  );
}
