import React, { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from './Icon';
import type { Variants } from 'framer-motion';
import { SideNav } from './SideNav';
import { TopBar } from './TopBar';
import { BottomNav } from './BottomNav';
import { AppFooter } from './AppFooter';
import { CrystalPanel } from './CrystalPanel';
import { useSidebarState } from '../hooks/useSidebarState';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useSurveys } from '../hooks/useSurveys';
import { CrystalPanelProvider, useCrystalPanel } from '../contexts/crystalPanel';
import { ROUTES } from '../constants/routes';

const pageVariants: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, y: -6, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } },
};

// Inner shell — consumes CrystalPanelProvider so ⌘K can call toggleCrystal.
function AppShellInner() {
  const { isExpanded, toggle, setExpanded } = useSidebarState();
  const breakpoint = useBreakpoint();
  const location = useLocation();
  const { toggleCrystal, scope, isOpen, closeCrystal } = useCrystalPanel();
  const { surveys } = useSurveys();

  const isMobile = breakpoint === 'mobile';
  const isTablet = breakpoint === 'tablet';
  // Full-bleed "no chrome" treatment is for the survey QUESTION builder only
  // (it owns its own viewport + its own XperiqCopilot assistant/⌘K, per the
  // comment below). This regex previously ALSO matched `/app/workflows/build`
  // (Wave 14 bug report) — and, being a substring test, silently matched
  // `/app/workflows/build/nl` too — meaning both workflow builder pages have
  // been running chrome-less (no gutters/footer/BottomNav/CrystalPanel/⌘K)
  // by accident. Neither page's own layout expects this (both use a normal
  // `max-w-* mx-auto` container, per `app/src/pages/CLAUDE.md`'s page
  // pattern) — narrowed to an exact regex so only the survey builder's
  // dynamic `:id` segment matches, never a workflow route.
  const isBuilder = /^\/surveys\/[^/]+\/build$/.test(location.pathname);
  // The two "unified builder" pages (Wave 14) each mount their own
  // contextual `AskCrystalFab` — suppress AppShell's generic default Crystal
  // FAB there so re-enabling `CrystalPanel` on these routes (via the fix
  // above) doesn't produce two overlapping "open Crystal" buttons in the
  // same corner.
  const hasOwnCrystalFab = location.pathname === ROUTES.WORKFLOW_BUILD || location.pathname === ROUTES.WORKFLOW_CANVAS;

  useEffect(() => {
    if (isTablet) setExpanded(false);
  }, [isTablet]);

  // Close Crystal on every navigation — each page starts fresh with the icon
  useEffect(() => {
    closeCrystal();
  }, [location.pathname, closeCrystal]);

  // Global ⌘K / Ctrl+K shortcut to toggle Crystal panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        // Don't intercept ⌘K inside the survey builder (XperiqCopilot owns it there)
        if (isBuilder) return;
        e.preventDefault();
        toggleCrystal();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isBuilder, toggleCrystal]);

  const sidebarWidth = isMobile ? '0px' : isExpanded ? '16rem' : '3.5rem';

  return (
    <div
      className="min-h-screen bg-surface overflow-x-hidden"
      style={{ '--sidebar-width': sidebarWidth } as React.CSSProperties}
    >
      {!isMobile && <SideNav isExpanded={isExpanded} onToggle={toggle} />}
      <TopBar onMenuToggle={toggle} />

      <main
        className="overflow-x-hidden min-h-screen flex flex-col"
        style={{
          marginLeft: sidebarWidth,
          paddingTop: '4rem',
          transition: 'margin-left 250ms ease',
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={location.pathname}
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="flex-1 flex flex-col overflow-x-hidden"
          >
            {isBuilder ? (
              /* Builder gets the full viewport — no gutters, no footer, no BottomNav clearance */
              <Outlet />
            ) : (
              /* Standard pages: consistent gutters + BottomNav clearance + footer */
              <div className="px-6 md:px-8 pb-24 md:pb-8 w-full flex-1 flex flex-col">
                <Outlet />
                <AppFooter />
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {isMobile && !isBuilder && <BottomNav />}

      {/* Global Crystal panel — available on every authenticated route.
          Pages inject their data via setCrystalData(); scope is set via setScope(). */}
      {!isBuilder && (
        <CrystalPanel scope={scope} surveys={surveys} insights={null} />
      )}

      {/* Crystal FAB — collapsed icon when panel is closed. Suppressed on the
          two Wave 14 unified-builder pages (they mount their own contextual
          AskCrystalFab instead — see `hasOwnCrystalFab` above). */}
      <AnimatePresence>
        {!isBuilder && !hasOwnCrystalFab && !isOpen && (
          <motion.button
            key="crystal-fab"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.93 }}
            onClick={toggleCrystal}
            title="Ask Crystal (⌘K)"
            aria-label="Open Crystal AI assistant"
            className="fixed z-40 flex items-center justify-center rounded-full"
            style={{
              bottom: isMobile ? '5.5rem' : '1.5rem',
              right: '1.5rem',
              width: 52,
              height: 52,
              background: 'linear-gradient(135deg, #2a4bd9 0%, #8329c8 100%)',
              boxShadow: '0 8px 24px rgba(42,75,217,0.40), 0 2px 8px rgba(0,0,0,0.12)',
            }}
          >
            <Icon name="diamond" size={22} style={{ color: 'white' }} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

export function AppShell() {
  return (
    <CrystalPanelProvider>
      <AppShellInner />
    </CrystalPanelProvider>
  );
}
