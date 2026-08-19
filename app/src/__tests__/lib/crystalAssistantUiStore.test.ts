import { describe, it, expect, beforeEach } from 'vitest';
import {
  CRYSTAL_ASSISTANT_UI_STORAGE_KEY,
  createAssistantMessage,
  createEmptyThread,
  createUserMessage,
  loadThreadsFromStorage,
  persistThreadsToStorage,
  type StoredCrystalThread,
} from '../../lib/crystalAssistantUiStore';

beforeEach(() => {
  window.localStorage.clear();
});

describe('crystalAssistantUiStore — createEmptyThread / message factories', () => {
  it('creates a thread with the given title, regular status, and no messages', () => {
    const thread = createEmptyThread('My thread');
    expect(thread.title).toBe('My thread');
    expect(thread.status).toBe('regular');
    expect(thread.messages).toEqual([]);
  });

  it('gives each new thread a unique id', () => {
    const a = createEmptyThread('A');
    const b = createEmptyThread('B');
    expect(a.id).not.toBe(b.id);
  });

  it('creates a user message with role "user" and the given content', () => {
    const msg = createUserMessage('hello');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('hello');
    expect(msg.id).toBeTruthy();
  });

  it('creates an assistant message with role "assistant"', () => {
    const msg = createAssistantMessage('hi there');
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('hi there');
  });
});

describe('crystalAssistantUiStore — persistThreadsToStorage / loadThreadsFromStorage', () => {
  it('round-trips an empty list', () => {
    persistThreadsToStorage([]);
    expect(loadThreadsFromStorage()).toEqual([]);
  });

  it('round-trips a populated thread list under the namespaced storage key', () => {
    const threads: StoredCrystalThread[] = [createEmptyThread('Thread 1')];
    persistThreadsToStorage(threads);

    const raw = window.localStorage.getItem(CRYSTAL_ASSISTANT_UI_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(loadThreadsFromStorage()).toEqual(threads);
  });

  it('preserves messages across a round trip', () => {
    const thread = createEmptyThread('With messages');
    thread.messages = [createUserMessage('hi'), createAssistantMessage('hello!')];
    persistThreadsToStorage([thread]);

    const loaded = loadThreadsFromStorage();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].messages).toHaveLength(2);
    expect(loaded[0].messages[0].content).toBe('hi');
    expect(loaded[0].messages[1].content).toBe('hello!');
  });

  it('returns [] when storage is empty', () => {
    expect(loadThreadsFromStorage()).toEqual([]);
  });

  it('returns [] when storage holds malformed JSON', () => {
    window.localStorage.setItem(CRYSTAL_ASSISTANT_UI_STORAGE_KEY, '{not json');
    expect(loadThreadsFromStorage()).toEqual([]);
  });

  it('returns [] when storage holds a JSON value that is not an array', () => {
    window.localStorage.setItem(CRYSTAL_ASSISTANT_UI_STORAGE_KEY, JSON.stringify({ oops: true }));
    expect(loadThreadsFromStorage()).toEqual([]);
  });

  it('filters out malformed entries (missing required fields) instead of throwing', () => {
    window.localStorage.setItem(
      CRYSTAL_ASSISTANT_UI_STORAGE_KEY,
      JSON.stringify([{ id: 'ok', title: 'Fine', messages: [] }, { id: 'bad' }, null, 'nonsense']),
    );
    const loaded = loadThreadsFromStorage();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('ok');
  });
});
