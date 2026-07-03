/**
 * AppShell — route-based chrome/CrystalPanel gating.
 *
 * Wave 14 bug (user-reported: "Clicking crystal icon after clicking Build
 * workflow, does not even work"): `isBuilder`'s regex matched
 * `/app/workflows/build` (and, as a substring test, `/app/workflows/build/nl`
 * too) in addition to the survey question builder it was meant for. When
 * `isBuilder` is true, AppShell does not render `<CrystalPanel>` in the DOM at
 * all — so the new `AskCrystalFab` on `WorkflowBuilderPage` called
 * `openCrystal()` against a component that was never mounted: a silent no-op.
 *
 * This file renders the REAL `AppShell` (real `CrystalPanelProvider`, real
 * routing-driven conditional logic) — every other Crystal test in this repo
 * mocks `useCrystalPanel()` directly, which is exactly why this class of bug
 * was invisible to every previous test pass. Only CrystalPanel's own internal
 * behavior is stubbed out here (already covered by `CrystalPanel.test.tsx`);
 * AppShell's routing decision is the unit under test.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AppShell } from '../../components/AppShell';
import { ROUTES } from '../../constants/routes';

afterEach(cleanup);

vi.mock('framer-motion', () => ({
  motion: {
    div: (p: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => <div {...p} />,
    button: (p: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => <button {...p} />,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../components/SideNav', () => ({ SideNav: () => <div data-testid="side-nav" /> }));
vi.mock('../../components/TopBar', () => ({ TopBar: () => <div data-testid="top-bar" /> }));
vi.mock('../../components/BottomNav', () => ({ BottomNav: () => <div data-testid="bottom-nav" /> }));
vi.mock('../../components/AppFooter', () => ({ AppFooter: () => <div data-testid="app-footer" /> }));
// CrystalPanel itself is stubbed — its own internals are CrystalPanel.test.tsx's
// job. Here we only care WHETHER AppShell renders it at all for a given route.
vi.mock('../../components/CrystalPanel', () => ({
  CrystalPanel: () => <div data-testid="crystal-panel-mounted" />,
}));
vi.mock('../../hooks/useSidebarState', () => ({
  useSidebarState: () => ({ isExpanded: true, toggle: vi.fn(), setExpanded: vi.fn() }),
}));
vi.mock('../../hooks/useBreakpoint', () => ({ useBreakpoint: () => 'desktop' }));
vi.mock('../../hooks/useSurveys', () => ({ useSurveys: () => ({ surveys: [] }) }));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path={path} element={<div data-testid="page-content">page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AppShell — CrystalPanel + chrome gating by route', () => {
  it('REGRESSION: mounts CrystalPanel on the workflow sentence builder route', () => {
    renderAt(ROUTES.WORKFLOW_BUILD);
    expect(screen.getByTestId('crystal-panel-mounted')).toBeInTheDocument();
  });

  it('REGRESSION: mounts CrystalPanel on the Crystal NL builder route (also previously over-matched)', () => {
    renderAt(ROUTES.WORKFLOW_NL_BUILD);
    expect(screen.getByTestId('crystal-panel-mounted')).toBeInTheDocument();
  });

  it('mounts CrystalPanel on the canvas builder route (was already correct pre-Wave-14)', () => {
    renderAt(ROUTES.WORKFLOW_CANVAS);
    expect(screen.getByTestId('crystal-panel-mounted')).toBeInTheDocument();
  });

  it('mounts CrystalPanel on an ordinary page (e.g. the workflows list)', () => {
    renderAt(ROUTES.WORKFLOWS);
    expect(screen.getByTestId('crystal-panel-mounted')).toBeInTheDocument();
  });

  it('does NOT mount CrystalPanel on the survey question builder (full-bleed, has its own XperiqCopilot)', () => {
    renderAt('/surveys/survey-123/build');
    expect(screen.queryByTestId('crystal-panel-mounted')).not.toBeInTheDocument();
  });

  it('restores footer/BottomNav-clearance chrome on the workflow builder route (previously suppressed by the same bug)', () => {
    renderAt(ROUTES.WORKFLOW_BUILD);
    expect(screen.getByTestId('app-footer')).toBeInTheDocument();
  });

  it('still suppresses chrome on the real survey builder route (unchanged, intentional behavior)', () => {
    renderAt('/surveys/survey-123/build');
    expect(screen.queryByTestId('app-footer')).not.toBeInTheDocument();
  });

  it('REGRESSION: does not render the generic default Crystal FAB on the sentence builder (it has its own AskCrystalFab — avoids a duplicate button)', () => {
    renderAt(ROUTES.WORKFLOW_BUILD);
    expect(screen.queryByRole('button', { name: /open crystal ai assistant/i })).not.toBeInTheDocument();
  });

  it('REGRESSION: does not render the generic default Crystal FAB on the canvas builder either (same duplicate-button risk)', () => {
    renderAt(ROUTES.WORKFLOW_CANVAS);
    expect(screen.queryByRole('button', { name: /open crystal ai assistant/i })).not.toBeInTheDocument();
  });

  it('still renders the generic default Crystal FAB on an ordinary page', () => {
    renderAt(ROUTES.WORKFLOWS);
    expect(screen.getByRole('button', { name: /open crystal ai assistant/i })).toBeInTheDocument();
  });
});
