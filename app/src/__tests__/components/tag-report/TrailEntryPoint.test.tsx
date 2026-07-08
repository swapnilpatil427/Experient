import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../lib/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { TrailEntryPoint } from '../../../components/tag-report/TrailEntryPoint';

afterEach(cleanup);
beforeEach(() => mockNavigate.mockReset());

describe('TrailEntryPoint', () => {
  it('renders the description and CTA', () => {
    render(<TrailEntryPoint tagId="tag-1" />);
    expect(screen.getByText('tagReport.trailEntry.description')).toBeInTheDocument();
    expect(screen.getByText('tagReport.trailEntry.cta')).toBeInTheDocument();
  });

  it('navigates to the trail route for the given tagId on click', async () => {
    const user = userEvent.setup();
    render(<TrailEntryPoint tagId="tag-77" />);
    await user.click(screen.getByText('tagReport.trailEntry.cta'));
    expect(mockNavigate).toHaveBeenCalledWith('/app/experience/tags/tag-77/report/trail');
  });
});
