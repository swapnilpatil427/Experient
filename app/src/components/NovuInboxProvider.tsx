import { useState, useEffect } from 'react';
import { Inbox } from '@novu/react';
import { useApi } from '../hooks/useApi';

interface Props { userId: string; orgId: string; }

// Wave 19b (WAVE19_CRYSTAL_IDENTITY_TOKEN_SPEC.md §4.4): Novu's `appearance.
// variables` is a plain JS config object consumed by the `@novu/react` SDK,
// not a CSS rule — a literal 'var(--color-primary)' string won't resolve the
// way it does in a `style` object. We read the brand-reactive CSS custom
// property via `getComputedStyle` at mount time instead, so an org's custom
// brand color still reaches the notification inbox. Not imported from
// NLThinkingCrystal.tsx (which has its own copy of this helper) — deliberately
// duplicated locally per spec guidance rather than a cross-module import.
const DEFAULT_COLOR_PRIMARY = '#2a4bd9';

export function resolveCssVarColor(varName: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || fallback;
}

export function NovuInboxProvider({ userId, orgId }: Props) {
  const appId = import.meta.env.VITE_NOVU_APP_ID;
  const api = useApi();
  const [subscriberHash, setSubscriberHash] = useState<string | undefined>(undefined);
  const [colorPrimary, setColorPrimary] = useState(DEFAULT_COLOR_PRIMARY);

  // orgId is available for future use (e.g. tenant-scoped subscriber HMAC)
  void orgId;

  useEffect(() => {
    if (!appId || !userId) return;
    (api as unknown as { get: (url: string) => Promise<{ data: { hash: string } }> })
      .get('/api/crystal-novu/subscriber-hash')
      .then((res) => setSubscriberHash(res.data.hash))
      .catch(() => {}); // non-fatal — falls back to unhashed mode
  }, [userId, appId, api]);

  useEffect(() => {
    setColorPrimary(resolveCssVarColor('--color-primary', DEFAULT_COLOR_PRIMARY));
  }, []);

  if (!appId || !userId) return null;

  return (
    <Inbox
      applicationIdentifier={appId}
      subscriberId={userId}
      subscriberHash={subscriberHash}
      appearance={{
        variables: {
          colorPrimary,
          colorForeground: '#1a1a2e',
        },
      }}
    />
  );
}
