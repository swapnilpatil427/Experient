import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../lib/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { ExperienceSubNav } from '../../components/ExperienceSubNav';

afterEach(cleanup);

describe('ExperienceSubNav', () => {
  it('renders both Overview and Reports links', () => {
    render(<MemoryRouter><ExperienceSubNav active="overview" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'tagReport.nav.overview' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'tagReport.nav.reports' })).toBeInTheDocument();
  });

  it('links point at EXPERIENCE and TAG_REPORTS_INDEX respectively', () => {
    render(<MemoryRouter><ExperienceSubNav active="overview" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'tagReport.nav.overview' })).toHaveAttribute('href', '/app/experience');
    expect(screen.getByRole('link', { name: 'tagReport.nav.reports' })).toHaveAttribute('href', '/app/experience/reports');
  });

  it('applies the active styling to the current segment (overview)', () => {
    render(<MemoryRouter><ExperienceSubNav active="overview" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'tagReport.nav.overview' }).className).toMatch(/bg-white/);
    expect(screen.getByRole('link', { name: 'tagReport.nav.reports' }).className).not.toMatch(/bg-white/);
  });

  it('applies the active styling to the current segment (reports)', () => {
    render(<MemoryRouter><ExperienceSubNav active="reports" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'tagReport.nav.reports' }).className).toMatch(/bg-white/);
    expect(screen.getByRole('link', { name: 'tagReport.nav.overview' }).className).not.toMatch(/bg-white/);
  });
});
