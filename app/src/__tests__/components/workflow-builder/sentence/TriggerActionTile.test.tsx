import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TriggerTile } from '../../../../components/workflow-builder/sentence/TriggerTile';
import { ActionTile } from '../../../../components/workflow-builder/sentence/ActionTile';

afterEach(cleanup);

describe('TriggerTile', () => {
  it('renders label, description, and icon; calls onSelect when clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <TooltipProvider>
        <TriggerTile
          type="score.nps_drop" label="NPS dropped" description="Fires when NPS drops" icon="speed"
          isCrystal={false} selected={false} onSelect={onSelect}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText('NPS dropped')).toBeInTheDocument();
    expect(screen.getByText('Fires when NPS drops')).toBeInTheDocument();
    await user.click(screen.getByTestId('trigger-tile-score.nps_drop'));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('shows the Crystal badge when isCrystal is true', () => {
    render(
      <TooltipProvider>
        <TriggerTile type="crystal.insight_ready" label="Insight ready" description="d" icon="auto_awesome" isCrystal selected={false} onSelect={() => {}} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Crystal')).toBeInTheDocument();
  });

  it('reflects selected state via aria-pressed', () => {
    render(
      <TooltipProvider>
        <TriggerTile type="score.nps_drop" label="NPS dropped" description="d" icon="speed" isCrystal={false} selected onSelect={() => {}} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('trigger-tile-score.nps_drop')).toHaveAttribute('aria-pressed', 'true');
  });

  // Finding: Maya DEEP_AUDIT_PM_FINDINGS.md 2c / Rohan DEEP_AUDIT_UX_FINDINGS.md
  // T-1 (independently confirmed) — 7 of 13 registry triggers (backend/src/lib/
  // workflowRegistry.ts) have zero backend producer and will never fire, but
  // `TriggerTileProps` (this file) carries no `live`/readiness field at all,
  // unlike `ActionTileProps` below which does. A fix needs a readiness dot on
  // TriggerTile mirroring ActionTile's `data-testid="trigger-readiness-<type>"`
  // / `data-readiness` pattern. This test asserts that fix-shaped expectation —
  // it is RED against current code (TriggerTile renders no such node at all),
  // which is the executable proof that T-1/2c is real, not just documented.
  it('renders a readiness dot distinguishing a no-producer trigger from a live one — RED, proves T-1/2c', () => {
    render(
      <TooltipProvider>
        {/* score.nps_drop: registry comment confirms "no producer wired up yet ... will never fire" */}
        <TriggerTile type="score.nps_drop" label="NPS dropped" description="Fires when NPS drops" icon="speed" isCrystal={false} selected={false} onSelect={() => {}} />
      </TooltipProvider>,
    );
    // A correct fix would render a readiness dot analogous to ActionTile's,
    // flagging this trigger as having no backend producer (e.g. data-readiness
    // "stub"/"none"). Today TriggerTile has no such prop or DOM node at all, so
    // this assertion fails — the missing node IS the bug.
    expect(screen.getByTestId('trigger-readiness-score.nps_drop')).toHaveAttribute('data-readiness');
  });

  // A-1 (DEEP_AUDIT_UX_FINDINGS.md §8, Wave 11) — the readiness dot's tooltip
  // text was only reachable via hover/focus (Radix Tooltip). This proves a
  // keyboard/screen-reader-reachable text alternative exists via
  // aria-describedby, without asserting on the Tooltip's own open state.
  it('A-1: readiness dot has an sr-only text alternative reachable via aria-describedby', () => {
    render(
      <TooltipProvider>
        <TriggerTile type="score.nps_drop" label="NPS dropped" description="d" icon="speed" isCrystal={false} selected={false} onSelect={() => {}} live={false} />
      </TooltipProvider>,
    );
    const dot = screen.getByTestId('trigger-readiness-score.nps_drop');
    const describedById = dot.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById!)).toHaveTextContent(/no backend producer/i);
  });

  it('A-1: Crystal badge has an sr-only text alternative reachable via aria-describedby', () => {
    render(
      <TooltipProvider>
        <TriggerTile type="crystal.insight_ready" label="Insight ready" description="d" icon="auto_awesome" isCrystal selected={false} onSelect={() => {}} />
      </TooltipProvider>,
    );
    const badgeWrapper = screen.getByText('Crystal').closest('span[aria-describedby]');
    expect(badgeWrapper).toBeTruthy();
    const describedById = badgeWrapper!.getAttribute('aria-describedby');
    expect(document.getElementById(describedById!)).toHaveTextContent(/growth plan/i);
  });
});

describe('ActionTile — readiness dot rendering', () => {
  it('renders a green/live readiness dot for live: true', () => {
    render(<TooltipProvider><ActionTile action="notify.slack" label="Slack message" live selected={false} onSelect={() => {}} /></TooltipProvider>);
    expect(screen.getByTestId('action-readiness-notify.slack')).toHaveAttribute('data-readiness', 'true');
  });

  it('renders an amber/stub readiness dot for live: "stub"', () => {
    render(<TooltipProvider><ActionTile action="crystal.summarize" label="Crystal summary" live="stub" selected={false} onSelect={() => {}} /></TooltipProvider>);
    expect(screen.getByTestId('action-readiness-crystal.summarize')).toHaveAttribute('data-readiness', 'stub');
  });

  it('renders a gray/env readiness dot for live: "env"', () => {
    render(<TooltipProvider><ActionTile action="jira.create_issue" label="Create Jira issue" live="env" selected={false} onSelect={() => {}} /></TooltipProvider>);
    expect(screen.getByTestId('action-readiness-jira.create_issue')).toHaveAttribute('data-readiness', 'env');
  });

  it('calls onSelect when clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<TooltipProvider><ActionTile action="notify.slack" label="Slack message" live selected={false} onSelect={onSelect} /></TooltipProvider>);
    await user.click(screen.getByTestId('action-tile-notify.slack'));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  // Finding: Maya DEEP_AUDIT_PM_FINDINGS.md 6c / Rohan DEEP_AUDIT_UX_FINDINGS.md
  // I-1 (independently confirmed) — `ActionTileProps.live` (this component) was
  // a static prop sourced from the workflowRegistry.ts `ActionDef.live` constant
  // ('env' for jira.create_issue/salesforce.*/servicenow.*/zendesk.*), never from
  // GET /api/workflow-credentials (the real per-org connector health used by
  // IntegrationsSettingsPage.tsx). Fixed: `ActionTile` now accepts an optional
  // `credentialStatus: 'connected'|'disconnected'` prop (wired from
  // WorkflowBuilderPage.tsx via workflowConnectorStatus.ts) that overrides the
  // static registry `live` tier for connector-backed actions.
  it('renders a distinct readiness state for a disconnected-org action vs a connected one — RED, proves I-1/6c', () => {
    render(
      <TooltipProvider>
        <ActionTile
          action="jira.create_issue"
          label="Create Jira issue"
          live="env"
          selected={false}
          onSelect={() => {}}
          credentialStatus="disconnected"
        />
      </TooltipProvider>,
    );
    // A correct fix renders a readiness value that reflects the org actually
    // being disconnected (e.g. 'disconnected'), not the static 'env' tier.
    expect(screen.getByTestId('action-readiness-jira.create_issue')).toHaveAttribute('data-readiness', 'disconnected');
  });

  // A-1 (DEEP_AUDIT_UX_FINDINGS.md §8, Wave 11) — mirrors the TriggerTile
  // assertion above: the readiness dot's meaning must be reachable without a
  // mouse hover.
  it('A-1: readiness dot has an sr-only text alternative reachable via aria-describedby', () => {
    render(<TooltipProvider><ActionTile action="crystal.summarize" label="Crystal summary" live="stub" selected={false} onSelect={() => {}} /></TooltipProvider>);
    const dot = screen.getByTestId('action-readiness-crystal.summarize');
    const describedById = dot.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById!)).toHaveTextContent(/not yet fully wired/i);
  });
});
