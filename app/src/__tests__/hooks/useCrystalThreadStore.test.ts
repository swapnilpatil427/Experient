import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useCrystalThreadStore } from '../../hooks/useCrystalThreadStore';
import { createUserMessage, loadThreadsFromStorage } from '../../lib/crystalAssistantUiStore';

beforeEach(() => {
  window.localStorage.clear();
});

describe('useCrystalThreadStore — initial state', () => {
  it('starts with a single default thread when storage is empty', () => {
    const { result } = renderHook(() => useCrystalThreadStore());
    expect(result.current.threads).toHaveLength(1);
    expect(result.current.currentThreadId).toBe(result.current.threads[0].id);
  });

  it('loads existing threads from localStorage instead of creating a new one', () => {
    window.localStorage.setItem(
      'xperiq.crystal.threads.v1',
      JSON.stringify([{ id: 't-existing', title: 'Existing', status: 'regular', messages: [], createdAt: 'x', updatedAt: 'x' }]),
    );
    const { result } = renderHook(() => useCrystalThreadStore());
    expect(result.current.threads).toHaveLength(1);
    expect(result.current.threads[0].id).toBe('t-existing');
  });
});

describe('useCrystalThreadStore — new thread / switch', () => {
  it('creates a new thread and switches the current thread to it', () => {
    const { result } = renderHook(() => useCrystalThreadStore());
    const firstId = result.current.currentThreadId;

    let newId = '';
    act(() => { newId = result.current.newThread(); });

    expect(newId).not.toBe(firstId);
    expect(result.current.threads).toHaveLength(2);
    expect(result.current.currentThreadId).toBe(newId);
  });

  it('switchToThread changes the active thread without altering the list', () => {
    const { result } = renderHook(() => useCrystalThreadStore());
    const firstId = result.current.currentThreadId;
    let secondId = '';
    act(() => { secondId = result.current.newThread(); });

    act(() => { result.current.switchToThread(firstId); });
    expect(result.current.currentThreadId).toBe(firstId);
    expect(result.current.threads.map((t) => t.id)).toEqual(expect.arrayContaining([firstId, secondId]));
  });
});

describe('useCrystalThreadStore — rename', () => {
  it('renames the given thread', () => {
    const { result } = renderHook(() => useCrystalThreadStore());
    const id = result.current.currentThreadId;

    act(() => { result.current.renameThread(id, 'Renamed conversation'); });

    expect(result.current.currentThread.title).toBe('Renamed conversation');
  });

  it('ignores a blank rename', () => {
    const { result } = renderHook(() => useCrystalThreadStore());
    const id = result.current.currentThreadId;
    const originalTitle = result.current.currentThread.title;

    act(() => { result.current.renameThread(id, '   '); });

    expect(result.current.currentThread.title).toBe(originalTitle);
  });
});

describe('useCrystalThreadStore — archive / unarchive', () => {
  it('marks a thread archived', () => {
    const { result } = renderHook(() => useCrystalThreadStore());
    const id = result.current.currentThreadId;

    act(() => { result.current.archiveThread(id); });

    expect(result.current.threads.find((t) => t.id === id)?.status).toBe('archived');
  });

  it('restores an archived thread to regular', () => {
    const { result } = renderHook(() => useCrystalThreadStore());
    const id = result.current.currentThreadId;

    act(() => { result.current.archiveThread(id); });
    act(() => { result.current.unarchiveThread(id); });

    expect(result.current.threads.find((t) => t.id === id)?.status).toBe('regular');
  });
});

describe('useCrystalThreadStore — delete', () => {
  it('removes the thread from the list', () => {
    const { result } = renderHook(() => useCrystalThreadStore());
    const firstId = result.current.currentThreadId;
    let secondId = '';
    act(() => { secondId = result.current.newThread(); });

    act(() => { result.current.deleteThread(secondId); });

    expect(result.current.threads.map((t) => t.id)).toEqual([firstId]);
  });

  it('falls back to a remaining thread when the active thread is deleted', () => {
    const { result } = renderHook(() => useCrystalThreadStore());
    const firstId = result.current.currentThreadId;
    let secondId = '';
    act(() => { secondId = result.current.newThread(); }); // current is now secondId

    act(() => { result.current.deleteThread(secondId); });

    expect(result.current.currentThreadId).toBe(firstId);
  });

  it('creates a fresh empty thread when the last remaining thread is deleted', () => {
    const { result } = renderHook(() => useCrystalThreadStore());
    const onlyId = result.current.currentThreadId;

    act(() => { result.current.deleteThread(onlyId); });

    expect(result.current.threads).toHaveLength(1);
    expect(result.current.threads[0].id).not.toBe(onlyId);
    expect(result.current.threads[0].messages).toEqual([]);
    expect(result.current.currentThreadId).toBe(result.current.threads[0].id);
  });
});

describe('useCrystalThreadStore — setMessages + persistence across remount', () => {
  it('persists messages to localStorage', () => {
    const { result } = renderHook(() => useCrystalThreadStore());
    const id = result.current.currentThreadId;
    const msg = createUserMessage('Does Crystal remember me?');

    act(() => { result.current.setMessages(id, [msg]); });

    const persisted = loadThreadsFromStorage();
    expect(persisted.find((t) => t.id === id)?.messages).toEqual([msg]);
  });

  it('survives a simulated remount (new hook instance reads the same localStorage)', () => {
    const first = renderHook(() => useCrystalThreadStore());
    const id = first.result.current.currentThreadId;
    const msg = createUserMessage('Remember this across reload');

    act(() => { first.result.current.setMessages(id, [msg]); });
    act(() => { first.result.current.renameThread(id, 'Persisted Thread'); });

    // Unmount — simulates a full page refresh, since this hook's only state
    // source is localStorage (no in-memory singleton/module cache to leak
    // across the "remount").
    first.unmount();

    const second = renderHook(() => useCrystalThreadStore());
    expect(second.result.current.threads).toHaveLength(1);
    expect(second.result.current.threads[0].id).toBe(id);
    expect(second.result.current.threads[0].title).toBe('Persisted Thread');
    expect(second.result.current.threads[0].messages).toEqual([msg]);
  });

  it('survives a remount after creating a second thread and switching to it', () => {
    const first = renderHook(() => useCrystalThreadStore());
    let secondId = '';
    act(() => { secondId = first.result.current.newThread(); });
    act(() => { first.result.current.setMessages(secondId, [createUserMessage('in thread two')]); });

    first.unmount();

    const second = renderHook(() => useCrystalThreadStore());
    expect(second.result.current.threads).toHaveLength(2);
    // currentThreadId itself is in-memory React state (not persisted) by
    // design — only the thread list + its messages are durable; a fresh
    // mount defaults back to the first thread in the persisted list, same as
    // a real page load with no separate "last active thread" concept in v1.
    expect(second.result.current.threads.some((t) => t.id === secondId)).toBe(true);
    expect(second.result.current.threads.find((t) => t.id === secondId)?.messages).toHaveLength(1);
  });
});
