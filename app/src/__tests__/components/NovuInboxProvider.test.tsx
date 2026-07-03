import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

// Wave 19b (WAVE19_CRYSTAL_IDENTITY_TOKEN_SPEC.md §4.4): Novu's `appearance.
// variables.colorPrimary` is a plain JS config object consumed by the
// `@novu/react` SDK, not a CSS rule — a literal 'var(--color-primary)' string
// won't resolve there. The fix resolves the brand-reactive CSS custom
// property via getComputedStyle at mount time instead. These tests prove (a)
// the resolver helper reads whatever is currently set on :root, with a safe
// default-hex fallback when unset, and (b) the component actually feeds that
// resolution into the Inbox's `colorPrimary` variable, not a stale/cached
// value from first mount.

const inboxPropsSpy = vi.fn();

vi.mock('@novu/react', () => ({
  Inbox: (props: { appearance?: { variables?: { colorPrimary?: string } } }) => {
    inboxPropsSpy(props);
    return <div data-testid="novu-inbox" />;
  },
}));

vi.mock('../../hooks/useApi', () => ({
  useApi: () => ({ get: vi.fn().mockResolvedValue({ data: { hash: 'test-hash' } }) }),
}));

import { NovuInboxProvider, resolveCssVarColor } from '../../components/NovuInboxProvider';

afterEach(() => {
  cleanup();
  inboxPropsSpy.mockClear();
  document.documentElement.style.cssText = '';
  vi.unstubAllEnvs();
});

describe('resolveCssVarColor (NovuInboxProvider local copy)', () => {
  it('falls back to the provided default when the CSS var is unset', () => {
    expect(resolveCssVarColor('--color-primary-does-not-exist', '#2a4bd9')).toBe('#2a4bd9');
  });

  it('resolves whatever value is currently set on :root', () => {
    document.documentElement.style.setProperty('--color-primary', '#e63946');
    expect(resolveCssVarColor('--color-primary', '#2a4bd9')).toBe('#e63946');
  });
});

describe('NovuInboxProvider — brand-color resolution on mount', () => {
  it('returns null and renders nothing when VITE_NOVU_APP_ID is unset', () => {
    const { container } = render(<NovuInboxProvider userId="user-1" orgId="org-1" />);
    expect(container.querySelector('[data-testid="novu-inbox"]')).toBeFalsy();
  });

  it('passes the default brand hex as colorPrimary when no custom brand is set on :root', async () => {
    vi.stubEnv('VITE_NOVU_APP_ID', 'test-app-id');
    render(<NovuInboxProvider userId="user-1" orgId="org-1" />);

    await waitFor(() => expect(inboxPropsSpy).toHaveBeenCalled());
    const lastCall = inboxPropsSpy.mock.calls[inboxPropsSpy.mock.calls.length - 1][0];
    expect(lastCall.appearance.variables.colorPrimary).toBe('#2a4bd9');
  });

  it('resolves the overridden --color-primary set on :root and feeds it into colorPrimary (proves the read is live, not stale)', async () => {
    document.documentElement.style.setProperty('--color-primary', '#e63946');
    vi.stubEnv('VITE_NOVU_APP_ID', 'test-app-id');

    render(<NovuInboxProvider userId="user-1" orgId="org-1" />);

    await waitFor(() => {
      const lastCall = inboxPropsSpy.mock.calls[inboxPropsSpy.mock.calls.length - 1][0];
      expect(lastCall.appearance.variables.colorPrimary).toBe('#e63946');
    });
  });
});
