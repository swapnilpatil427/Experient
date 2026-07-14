import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useTopicBreakdown } from '../../hooks/useOrgTopics';

afterEach(cleanup);

const pending: Array<{ resolve: (v: unknown) => void }> = [];

vi.mock('../../hooks/useApi', () => ({
  useApi: () => ({
    getOrgTopicBreakdown: vi.fn().mockImplementation(() => new Promise((resolve) => {
      pending.push({ resolve });
    })),
  }),
}));

describe('useTopicBreakdown', () => {
  it('ignores stale responses when a newer topic is requested', async () => {
    const { result } = renderHook(() => useTopicBreakdown());

    act(() => { result.current.load('Topic A'); });
    act(() => { result.current.load('Topic B'); });

    await act(async () => {
      pending[1].resolve({
        topicLabel: 'Topic B',
        frequency: 5,
        bySurvey: [],
        sampleQuotes: ['quote B'],
      });
    });

    expect(result.current.breakdown?.topicLabel).toBe('Topic B');

    await act(async () => {
      pending[0].resolve({
        topicLabel: 'Topic A',
        frequency: 9,
        bySurvey: [],
        sampleQuotes: ['quote A'],
      });
    });

    expect(result.current.breakdown?.topicLabel).toBe('Topic B');
  });
});
