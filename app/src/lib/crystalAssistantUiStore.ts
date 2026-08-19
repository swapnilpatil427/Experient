// Minimal assistant-ui adoption spike (docs/xperiq-assistant-ui/BRIEF.md).
//
// Pure, framework-free localStorage persistence for Crystal's assistant-ui thread
// list. Deliberately NOT the `crystal_threads` backend table (v1 or v2) — this is
// a client-only, zero-backend-dependency adapter per the brief's persistence
// reality check: assistant-ui's own multi-thread support requires either their
// hosted Assistant Cloud (third-party SaaS — explicitly out of scope) or a
// `RemoteThreadListAdapter` (implies a backend endpoint — also out of scope this
// pass). A future phase can swap this module for a real backend-owned adapter
// (keyed like `crystal_threads` v2: org_id/user_id/survey_id/scope) without
// touching the UI layer that consumes `useCrystalThreadStore`.
//
// Kept separate from the React hook (`useCrystalThreadStore.ts`) so the
// persistence logic itself is trivially unit-testable without rendering
// anything.

export const CRYSTAL_ASSISTANT_UI_STORAGE_KEY = 'xperiq.crystal.threads.v1';

export type StoredCrystalMessageRole = 'user' | 'assistant';

export interface StoredCrystalMessage {
  id: string;
  role: StoredCrystalMessageRole;
  content: string;
  createdAt: string; // ISO timestamp
}

export type StoredCrystalThreadStatus = 'regular' | 'archived';

export interface StoredCrystalThread {
  id: string;
  title: string;
  status: StoredCrystalThreadStatus;
  messages: StoredCrystalMessage[];
  createdAt: string;
  updatedAt: string;
}

function safeRandomId(prefix: string): string {
  // crypto.randomUUID is available in every modern browser + jsdom (via the
  // `crypto` global Vitest/jsdom expose); fall back to a timestamp+random
  // string so this never throws in an older/odd test environment.
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}_${crypto.randomUUID()}`;
    }
  } catch {
    // fall through
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createEmptyThread(title: string): StoredCrystalThread {
  const now = new Date().toISOString();
  return {
    id: safeRandomId('thread'),
    title,
    status: 'regular',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createUserMessage(content: string): StoredCrystalMessage {
  return { id: safeRandomId('msg'), role: 'user', content, createdAt: new Date().toISOString() };
}

export function createAssistantMessage(content: string): StoredCrystalMessage {
  return { id: safeRandomId('msg'), role: 'assistant', content, createdAt: new Date().toISOString() };
}

/** Reads and validates the persisted thread list. Never throws — returns `[]` on any parse/shape failure. */
export function loadThreadsFromStorage(storage: Storage = window.localStorage): StoredCrystalThread[] {
  try {
    const raw = storage.getItem(CRYSTAL_ASSISTANT_UI_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is StoredCrystalThread =>
      !!t && typeof t === 'object' &&
      typeof (t as StoredCrystalThread).id === 'string' &&
      typeof (t as StoredCrystalThread).title === 'string' &&
      Array.isArray((t as StoredCrystalThread).messages),
    );
  } catch {
    return [];
  }
}

export function persistThreadsToStorage(threads: StoredCrystalThread[], storage: Storage = window.localStorage): void {
  try {
    storage.setItem(CRYSTAL_ASSISTANT_UI_STORAGE_KEY, JSON.stringify(threads));
  } catch {
    // localStorage can throw (quota exceeded, private-browsing lockdown) — the
    // in-memory React state is still the source of truth for the current tab,
    // so a write failure only means the NEXT reload won't see the update.
  }
}
