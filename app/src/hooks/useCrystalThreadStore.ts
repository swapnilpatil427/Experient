// Minimal assistant-ui adoption spike (docs/xperiq-assistant-ui/BRIEF.md).
//
// React-state wrapper around `lib/crystalAssistantUiStore.ts`'s localStorage
// persistence. This hook is the single source of truth consumed by
// `useCrystalAssistantUiRuntime` (which adapts it into assistant-ui's
// `ExternalStoreAdapter` + `ExternalStoreThreadListAdapter` shape) — kept
// framework-agnostic-ish (plain useState/useCallback) so it's testable via
// `renderHook` without mounting any assistant-ui component.
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from '../lib/i18n';
import {
  createEmptyThread,
  loadThreadsFromStorage,
  persistThreadsToStorage,
  type StoredCrystalMessage,
  type StoredCrystalThread,
} from '../lib/crystalAssistantUiStore';

function persist(threads: StoredCrystalThread[]): StoredCrystalThread[] {
  persistThreadsToStorage(threads);
  return threads;
}

export interface CrystalThreadStore {
  threads: StoredCrystalThread[];
  currentThreadId: string;
  currentThread: StoredCrystalThread;
  setMessages: (threadId: string, messages: StoredCrystalMessage[]) => void;
  newThread: () => string;
  switchToThread: (threadId: string) => void;
  renameThread: (threadId: string, title: string) => void;
  archiveThread: (threadId: string) => void;
  unarchiveThread: (threadId: string) => void;
  deleteThread: (threadId: string) => void;
}

export function useCrystalThreadStore(): CrystalThreadStore {
  const { t } = useTranslation();
  const untitled = t('crystalAssistantUi.untitledThread');

  const [threads, setThreadsRaw] = useState<StoredCrystalThread[]>(() => {
    const loaded = loadThreadsFromStorage();
    return loaded.length > 0 ? loaded : [createEmptyThread(untitled)];
  });
  const [currentThreadId, setCurrentThreadId] = useState<string>(() => threads[0]!.id);

  // Wrap every setter so persistence happens exactly once, next to the state
  // update that caused it — no separate `useEffect(() => persist(threads))`,
  // which would double-write on the initial render and race with rapid
  // successive updates (e.g. user message + assistant reply in one turn).
  const setThreads = useCallback((updater: (prev: StoredCrystalThread[]) => StoredCrystalThread[]) => {
    setThreadsRaw((prev) => persist(updater(prev)));
  }, []);

  const currentThread = useMemo(
    () => threads.find((thr) => thr.id === currentThreadId) ?? threads[0]!,
    [threads, currentThreadId],
  );

  const setMessages = useCallback((threadId: string, messages: StoredCrystalMessage[]) => {
    setThreads((prev) => prev.map((thr) =>
      thr.id === threadId ? { ...thr, messages, updatedAt: new Date().toISOString() } : thr,
    ));
  }, [setThreads]);

  const newThread = useCallback((): string => {
    const created = createEmptyThread(untitled);
    setThreads((prev) => [created, ...prev]);
    setCurrentThreadId(created.id);
    return created.id;
  }, [setThreads, untitled]);

  const switchToThread = useCallback((threadId: string) => {
    setCurrentThreadId(threadId);
  }, []);

  const renameThread = useCallback((threadId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setThreads((prev) => prev.map((thr) =>
      thr.id === threadId ? { ...thr, title: trimmed, updatedAt: new Date().toISOString() } : thr,
    ));
  }, [setThreads]);

  const archiveThread = useCallback((threadId: string) => {
    setThreads((prev) => prev.map((thr) => (thr.id === threadId ? { ...thr, status: 'archived' } : thr)));
  }, [setThreads]);

  const unarchiveThread = useCallback((threadId: string) => {
    setThreads((prev) => prev.map((thr) => (thr.id === threadId ? { ...thr, status: 'regular' } : thr)));
  }, [setThreads]);

  const deleteThread = useCallback((threadId: string) => {
    // Compute the post-delete list from the current closure's `threads` (this
    // callback is re-created via the `[threads]` dep whenever it changes, so
    // it always reflects the latest committed state) and, if that empties the
    // list, mint the replacement thread once here so the exact same object —
    // same id — is used both inside the `setThreads` updater and in the
    // `setCurrentThreadId` call below. Relying on reading `threads` again
    // *after* calling `setThreads` would be wrong: React does not guarantee
    // the updater has run synchronously by the next line.
    const remaining = threads.filter((thr) => thr.id !== threadId);
    const replacement = remaining.length === 0 ? createEmptyThread(untitled) : null;

    setThreads((prev) => {
      const next = prev.filter((thr) => thr.id !== threadId);
      return next.length > 0 ? next : [replacement!];
    });

    if (currentThreadId === threadId) {
      setCurrentThreadId(remaining.length > 0 ? remaining[0]!.id : replacement!.id);
    }
  }, [setThreads, threads, currentThreadId, untitled]);

  return {
    threads,
    currentThreadId,
    currentThread,
    setMessages,
    newThread,
    switchToThread,
    renameThread,
    archiveThread,
    unarchiveThread,
    deleteThread,
  };
}
