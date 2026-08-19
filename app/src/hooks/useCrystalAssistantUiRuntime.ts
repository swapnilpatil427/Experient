// Minimal assistant-ui adoption spike (docs/xperiq-assistant-ui/BRIEF.md).
//
// Wires assistant-ui's `useExternalStoreRuntime` (NOT `useLocalRuntime` — see
// note below) to:
//   1. the existing, unmodified Crystal REST endpoint via
//      `useApi().crystalChat2(...)` (zero CrystalOS/backend changes), and
//   2. the localStorage-backed thread store (`useCrystalThreadStore`) via an
//      `ExternalStoreThreadListAdapter`.
//
// Why `useExternalStoreRuntime` and not `useLocalRuntime` as BRIEF.md's
// starting-point sketch suggested: per assistant-ui's own current source
// (`node_modules/@assistant-ui/core/dist/runtimes/external-store/external-store-adapter.d.ts`),
// `adapters.threadList: ExternalStoreThreadListAdapter` is only accepted by
// `ExternalStoreAdapterBase` — i.e. only `useExternalStoreRuntime` consumes it.
// `useLocalRuntime`'s own docs page states multi-thread support comes only via
// "AssistantCloud or a custom RemoteThreadListAdapter" — both of which are
// out of scope here (cloud = third-party data flow we were told not to add;
// RemoteThreadListAdapter implies a backend endpoint). So the two pieces
// BRIEF.md asked for — `useLocalRuntime` + `ExternalStoreThreadListAdapter` —
// are not actually combinable in the installed version (0.15.15). This file
// uses `useExternalStoreRuntime` instead, which is the supported pairing and
// requires no different concepts, just a different top-level hook.
import { useCallback, useMemo, useState } from 'react';
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { useApi } from './useApi';
import { useTranslation } from '../lib/i18n';
import { useCrystalThreadStore, type CrystalThreadStore } from './useCrystalThreadStore';
import {
  createAssistantMessage,
  createUserMessage,
  type StoredCrystalMessage,
} from '../lib/crystalAssistantUiStore';

export interface CrystalAssistantUiRuntimeOptions {
  surveyId?: string;
  focusedTopic?: string;
}

export function convertStoredMessageToThreadMessageLike(message: StoredCrystalMessage): ThreadMessageLike {
  return {
    role: message.role,
    content: message.content,
    id: message.id,
    createdAt: new Date(message.createdAt),
  };
}

export interface CrystalChatTurn {
  store: CrystalThreadStore;
  isRunning: boolean;
  /** Sends `text` as a new user turn on the current thread, then calls crystalChat2. */
  submit: (text: string) => Promise<void>;
}

/**
 * The API-calling half, split out from the assistant-ui runtime wiring below
 * so it's testable without rendering any assistant-ui component — `submit()`
 * is a plain async function callable directly from a `renderHook` test.
 */
export function useCrystalChatTurn(options: CrystalAssistantUiRuntimeOptions = {}): CrystalChatTurn {
  const { surveyId, focusedTopic } = options;
  const api = useApi();
  const { t } = useTranslation();
  const store = useCrystalThreadStore();
  const [isRunning, setIsRunning] = useState(false);

  const submit = useCallback(async (text: string) => {
    const threadId = store.currentThread.id;
    const conversationHistory = store.currentThread.messages.map((m) => ({ role: m.role, content: m.content }));

    const userMessage = createUserMessage(text);
    const withUser = [...store.currentThread.messages, userMessage];
    store.setMessages(threadId, withUser);

    setIsRunning(true);
    try {
      const result = await api.crystalChat2(text, { surveyId, focusedTopic, conversationHistory });
      store.setMessages(threadId, [...withUser, createAssistantMessage(result.answer)]);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      store.setMessages(threadId, [
        ...withUser,
        createAssistantMessage(t('crystalAssistantUi.errorAnswerPrefix', { message: messageText })),
      ]);
    } finally {
      setIsRunning(false);
    }
  }, [api, focusedTopic, store, surveyId, t]);

  return { store, isRunning, submit };
}

export interface CrystalAssistantUiRuntime {
  runtime: AssistantRuntime;
  store: CrystalThreadStore;
}

export function useCrystalAssistantUiRuntime(options: CrystalAssistantUiRuntimeOptions = {}): CrystalAssistantUiRuntime {
  const { store, isRunning, submit } = useCrystalChatTurn(options);

  const onNew = useCallback(async (message: AppendMessage) => {
    const firstPart = message.content[0];
    if (!firstPart || firstPart.type !== 'text') {
      throw new Error('Only plain text messages are supported in this spike.');
    }
    await submit(firstPart.text);
  }, [submit]);

  const threadList: ExternalStoreThreadListAdapter = useMemo(() => ({
    threadId: store.currentThreadId,
    threads: store.threads
      .filter((th) => th.status === 'regular')
      .map((th) => ({ id: th.id, status: 'regular' as const, title: th.title })),
    archivedThreads: store.threads
      .filter((th) => th.status === 'archived')
      .map((th) => ({ id: th.id, status: 'archived' as const, title: th.title })),
    onSwitchToNewThread: () => { store.newThread(); },
    onSwitchToThread: (threadId: string) => { store.switchToThread(threadId); },
    onRename: (threadId: string, newTitle: string) => { store.renameThread(threadId, newTitle); },
    onArchive: (threadId: string) => { store.archiveThread(threadId); },
    onUnarchive: (threadId: string) => { store.unarchiveThread(threadId); },
    onDelete: (threadId: string) => { store.deleteThread(threadId); },
  }), [store]);

  const runtime = useExternalStoreRuntime<StoredCrystalMessage>({
    messages: store.currentThread.messages,
    setMessages: (messages) => store.setMessages(store.currentThread.id, [...messages]),
    isRunning,
    convertMessage: convertStoredMessageToThreadMessageLike,
    onNew,
    adapters: { threadList },
  });

  return { runtime, store };
}
