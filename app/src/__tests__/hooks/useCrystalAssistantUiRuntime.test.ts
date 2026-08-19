import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock useApi before importing anything that transitively uses it.
vi.mock('../../hooks/useApi', () => ({
  useApi: vi.fn(),
  default: vi.fn(),
}));

import { useApi } from '../../hooks/useApi';
import { useCrystalChatTurn, useCrystalAssistantUiRuntime } from '../../hooks/useCrystalAssistantUiRuntime';

const mockCrystalChat2 = vi.fn();
const mockApi = { crystalChat2: mockCrystalChat2 };

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(useApi).mockReturnValue(mockApi as unknown as ReturnType<typeof useApi>);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useCrystalChatTurn — submit calls crystalChat2 with the right args', () => {
  it('calls crystalChat2 with the message, surveyId, focusedTopic, and empty history on the first turn', async () => {
    mockCrystalChat2.mockResolvedValue({ answer: 'Hi! How can I help?', suggestions: [], insight_refs: [], citations: [] });

    const { result } = renderHook(() => useCrystalChatTurn({ surveyId: 'survey-123', focusedTopic: 'Wait Time' }));

    await act(async () => { await result.current.submit('What is our NPS?'); });

    expect(mockCrystalChat2).toHaveBeenCalledTimes(1);
    expect(mockCrystalChat2).toHaveBeenCalledWith('What is our NPS?', {
      surveyId: 'survey-123',
      focusedTopic: 'Wait Time',
      conversationHistory: [],
    });
  });

  it('appends the user message immediately (before the API resolves)', async () => {
    let resolveChat!: (v: { answer: string; suggestions: string[]; insight_refs: string[]; citations: string[] }) => void;
    mockCrystalChat2.mockReturnValue(new Promise((res) => { resolveChat = res; }));

    const { result } = renderHook(() => useCrystalChatTurn({}));

    let submitPromise!: Promise<void>;
    act(() => { submitPromise = result.current.submit('Hello Crystal'); });

    expect(result.current.store.currentThread.messages).toHaveLength(1);
    expect(result.current.store.currentThread.messages[0]).toMatchObject({ role: 'user', content: 'Hello Crystal' });
    expect(result.current.isRunning).toBe(true);

    await act(async () => {
      resolveChat({ answer: 'Answer', suggestions: [], insight_refs: [], citations: [] });
      await submitPromise;
    });

    expect(result.current.isRunning).toBe(false);
  });

  it('appends the assistant answer after the API resolves', async () => {
    mockCrystalChat2.mockResolvedValue({ answer: 'NPS is 42', suggestions: [], insight_refs: [], citations: [] });

    const { result } = renderHook(() => useCrystalChatTurn({ surveyId: 's1' }));
    await act(async () => { await result.current.submit('What is our NPS?'); });

    const messages = result.current.store.currentThread.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'What is our NPS?' });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'NPS is 42' });
  });

  it('sends prior turns as conversationHistory on the second message', async () => {
    mockCrystalChat2.mockResolvedValue({ answer: 'First answer', suggestions: [], insight_refs: [], citations: [] });
    const { result } = renderHook(() => useCrystalChatTurn({ surveyId: 's1' }));

    await act(async () => { await result.current.submit('First question'); });
    mockCrystalChat2.mockResolvedValue({ answer: 'Second answer', suggestions: [], insight_refs: [], citations: [] });
    await act(async () => { await result.current.submit('Second question'); });

    expect(mockCrystalChat2).toHaveBeenLastCalledWith('Second question', {
      surveyId: 's1',
      focusedTopic: undefined,
      conversationHistory: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
      ],
    });
  });

  it('renders a fallback assistant message instead of throwing when the API rejects', async () => {
    mockCrystalChat2.mockRejectedValue(new Error('backend unreachable'));
    const { result } = renderHook(() => useCrystalChatTurn({}));

    await act(async () => { await result.current.submit('will fail'); });

    const messages = result.current.store.currentThread.messages;
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toContain('backend unreachable');
    expect(result.current.isRunning).toBe(false);
  });
});

describe('useCrystalAssistantUiRuntime — assembles a runtime + exposes the thread store', () => {
  it('returns a runtime object and the underlying thread store', () => {
    mockCrystalChat2.mockResolvedValue({ answer: 'ok', suggestions: [], insight_refs: [], citations: [] });
    const { result } = renderHook(() => useCrystalAssistantUiRuntime({ surveyId: 'survey-1' }));

    expect(result.current.runtime).toBeTruthy();
    expect(result.current.store.threads).toHaveLength(1);
  });

  it('the runtime thread reflects the store — appending via the runtime calls crystalChat2', async () => {
    mockCrystalChat2.mockResolvedValue({ answer: 'From runtime', suggestions: [], insight_refs: [], citations: [] });
    const { result } = renderHook(() => useCrystalAssistantUiRuntime({ surveyId: 'survey-1' }));

    await act(async () => {
      await result.current.runtime.thread.append('Hello via runtime');
    });

    await waitFor(() => expect(mockCrystalChat2).toHaveBeenCalledTimes(1));
    expect(mockCrystalChat2).toHaveBeenCalledWith('Hello via runtime', {
      surveyId: 'survey-1',
      focusedTopic: undefined,
      conversationHistory: [],
    });
  });
});
