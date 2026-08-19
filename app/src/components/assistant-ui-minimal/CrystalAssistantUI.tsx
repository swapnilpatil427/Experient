// Minimal assistant-ui adoption spike (docs/xperiq-assistant-ui/BRIEF.md).
//
// Top-level composition: wires `useCrystalAssistantUiRuntime` (REST chat model
// + localStorage thread list, see that file for why `useExternalStoreRuntime`
// is used instead of BRIEF.md's `useLocalRuntime` starting point) into
// `AssistantRuntimeProvider`, then renders a thread-list sidebar next to the
// thread itself — assistant-ui's own primitive shapes, Xperiq's brand tokens.
//
// Mounted only from `pages/dev/CrystalAssistantUIDevPage.tsx`, which is itself
// only reachable behind `import.meta.env.DEV` (see App.tsx). Deliberately does
// NOT touch `CrystalPanel.tsx` or `AppShell.tsx` — this is a new, parallel,
// dev-only surface, not a replacement.
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { useCrystalAssistantUiRuntime, type CrystalAssistantUiRuntimeOptions } from '../../hooks/useCrystalAssistantUiRuntime';
import { CrystalThread } from './CrystalThread';
import { CrystalThreadList } from './CrystalThreadList';

export function CrystalAssistantUI(options: CrystalAssistantUiRuntimeOptions) {
  const { runtime, store } = useCrystalAssistantUiRuntime(options);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div
        className="grid h-full min-h-0 grid-cols-[16rem_1fr] overflow-hidden rounded-xl border"
        style={{ borderColor: 'var(--color-outline-variant)', background: 'var(--color-surface)' }}
      >
        <aside
          className="min-h-0 border-r"
          style={{ borderColor: 'var(--color-outline-variant)', background: 'var(--color-surface-container-low)' }}
        >
          <CrystalThreadList store={store} />
        </aside>
        <div className="min-h-0" style={{ background: 'var(--color-surface-container-lowest)' }}>
          <CrystalThread />
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
