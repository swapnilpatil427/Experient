import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../lib/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k),
  }),
}));

import { InFlightRunBanner } from '../../../components/tag-report/InFlightRunBanner';

afterEach(cleanup);

describe('InFlightRunBanner', () => {
  it('renders the banner with a relative time computed from startedAt', () => {
    const startedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 min ago
    render(<InFlightRunBanner notice={{ startedAt, trigger: 'manual' }} onDismiss={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/tagReport\.inFlight\.minutesAgo/);
  });

  it('shows "moments ago" for a run started under a minute ago', () => {
    const startedAt = new Date(Date.now() - 5000).toISOString();
    render(<InFlightRunBanner notice={{ startedAt, trigger: 'manual' }} onDismiss={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/tagReport\.inFlight\.momentsAgo/);
  });

  it('calls onDismiss when the dismiss link is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<InFlightRunBanner notice={{ startedAt: new Date().toISOString(), trigger: 'scheduled' }} onDismiss={onDismiss} />);
    await user.click(screen.getByText('tagReport.inFlight.dismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
