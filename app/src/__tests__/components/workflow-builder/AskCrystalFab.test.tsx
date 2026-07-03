import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// jsdom in this project's vitest config doesn't wire up a real localStorage
// backing store — same minimal in-memory polyfill precedent as
// IntegrationsSettingsPage.test.tsx's dismiss-banner persistence test.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear() { this.store.clear(); }
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
  key(index: number) { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string) { this.store.delete(key); }
  setItem(key: string, value: string) { this.store.set(key, String(value)); }
}
Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true });

vi.mock('../../../lib/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../../components/Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

import { AskCrystalFab } from '../../../components/workflow-builder/AskCrystalFab';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('AskCrystalFab', () => {
  it('renders a single trigger button', () => {
    render(<AskCrystalFab onOpen={() => {}} />);
    expect(screen.getByTestId('ask-crystal-fab')).toBeInTheDocument();
  });

  it('calls onOpen when clicked', async () => {
    const onOpen = vi.fn();
    render(<AskCrystalFab onOpen={onOpen} />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('ask-crystal-fab'));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('has the accessible aria-label/title from the fuller "aria" copy key', () => {
    render(<AskCrystalFab onOpen={() => {}} />);
    const button = screen.getByTestId('ask-crystal-fab');
    expect(button).toHaveAttribute('aria-label', 'workflows.builder.askCrystal.aria');
    expect(button).toHaveAttribute('title', 'workflows.builder.askCrystal.aria');
  });

  it('shows the first-view label chip after a delay when not previously seen', async () => {
    render(<AskCrystalFab onOpen={() => {}} />);
    expect(screen.queryByText('workflows.builder.askCrystal.label')).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('workflows.builder.askCrystal.label')).toBeInTheDocument(), { timeout: 3000 });
  }, 8000);

  it('does not show the label chip again once dismissed (localStorage-gated, one-time only)', async () => {
    window.localStorage.setItem('askCrystalFabSeen', 'true');
    render(<AskCrystalFab onOpen={() => {}} />);

    // Give the delayed-entrance timer a chance to fire, then assert it never rendered.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(screen.queryByText('workflows.builder.askCrystal.label')).not.toBeInTheDocument();
  }, 8000);

  it('dismissing the label chip persists the seen flag to localStorage', async () => {
    render(<AskCrystalFab onOpen={() => {}} />);

    await waitFor(() => expect(screen.getByText('workflows.builder.askCrystal.label')).toBeInTheDocument(), { timeout: 3000 });

    const user = userEvent.setup();
    await user.click(screen.getByText('workflows.builder.askCrystal.label'));

    expect(window.localStorage.getItem('askCrystalFabSeen')).toBe('true');
    expect(screen.queryByText('workflows.builder.askCrystal.label')).not.toBeInTheDocument();
  }, 8000);

  it('clicking the FAB itself (while the chip is showing) also dismisses the chip and still opens Crystal', async () => {
    const onOpen = vi.fn();
    render(<AskCrystalFab onOpen={onOpen} />);

    await waitFor(() => expect(screen.getByText('workflows.builder.askCrystal.label')).toBeInTheDocument(), { timeout: 3000 });

    const user = userEvent.setup();
    await user.click(screen.getByTestId('ask-crystal-fab'));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('askCrystalFabSeen')).toBe('true');
  }, 8000);
});
