import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../../lib/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('framer-motion', () => ({
  motion: { span: (p: React.ComponentProps<'span'>) => <span {...p} /> },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The real Three.js scene requires WebGL, which jsdom doesn't provide — mock it
// so we can test the reduced-motion GATING LOGIC (the part this component is
// actually responsible for; app/CLAUDE.md notes HeroCanvas has no internal RM
// gate, so this wrapper owns that behavior) without needing a real canvas.
vi.mock('../../../components/tag-report/three/TagReportScene', () => ({
  TagReportScene: () => <div data-testid="three-scene" />,
}));

import { PipelineVisualization } from '../../../components/tag-report/PipelineVisualization';

afterEach(cleanup);

function mockMatchMedia(reduced: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduced,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('PipelineVisualization', () => {
  beforeEach(() => {
    mockMatchMedia(false);
  });

  it('renders the accessible text stepper (not the canvas) when prefers-reduced-motion is set', () => {
    mockMatchMedia(true);
    render(<PipelineVisualization events={[]} />);
    expect(screen.getByTestId('tag-report-stepper')).toBeInTheDocument();
    expect(screen.queryByTestId('tag-report-pipeline-viz')).not.toBeInTheDocument();
  });

  it('mounts the (lazy) Three.js scene when motion is allowed', async () => {
    render(<PipelineVisualization events={[]} />);
    expect(screen.getByTestId('tag-report-pipeline-viz')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('three-scene')).toBeInTheDocument());
  });

  it('renders an aria-hidden-safe live region announcing the current stage', () => {
    render(<PipelineVisualization events={[]} />);
    const liveRegion = document.querySelector('[aria-live="polite"]');
    expect(liveRegion).toBeInTheDocument();
    expect(liveRegion).toHaveTextContent('tagReport.stream.stageLabel.discovery');
  });

  it('renders the collapsed strip (fixed height, no progress rail) when collapsed=true', () => {
    render(<PipelineVisualization events={[]} collapsed />);
    const viz = screen.getByTestId('tag-report-pipeline-viz');
    expect(viz.getAttribute('style')).toContain('height: 120px');
  });

  it('renders the 6-segment progress rail when not collapsed', () => {
    const { container } = render(<PipelineVisualization events={[]} collapsed={false} />);
    const rail = container.querySelector('.absolute.bottom-3');
    expect(rail?.children.length).toBe(6);
  });

  it('reflects backfill state in the live-region announcement', () => {
    render(
      <PipelineVisualization
        events={[
          { ts: 't', run_id: 'r', event: 'survey_selected', survey_id: 's1', position: 0, title: 'S1', created_at: '2026-01-01' },
          { ts: 't', run_id: 'r', event: 'survey_excluded', survey_id: 's1', reason: 'no_checkpoint_in_range' },
        ]}
      />
    );
    const liveRegion = document.querySelector('[aria-live="polite"]');
    expect(liveRegion).toHaveTextContent(/tagReport\.stream\.liveAnnouncement/);
  });
});
