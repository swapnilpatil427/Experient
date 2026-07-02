import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Workflow } from '../../types';

// Mock useApi and dataBus before importing the hook under test.
vi.mock('../../hooks/useApi', () => ({
  useApi: vi.fn(),
  default: vi.fn(),
}));
vi.mock('../../lib/dataBus', () => ({
  invalidate: vi.fn(),
  useInvalidation: vi.fn(),
}));

import { useApi } from '../../hooks/useApi';
import { useWorkflows } from '../../hooks/useWorkflows';

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf1',
    name: 'NPS Drop Alert',
    condition: {},
    action: {},
    status: 'active',
    trigger_count: 10,
    ...overrides,
  } as Workflow;
}

const mockListWorkflows = vi.fn();
const mockToggleWorkflow = vi.fn();
const mockDeleteWorkflow = vi.fn();

const mockApi = {
  listWorkflows: mockListWorkflows,
  toggleWorkflow: mockToggleWorkflow,
  deleteWorkflow: mockDeleteWorkflow,
};

beforeEach(() => {
  vi.mocked(useApi).mockReturnValue(mockApi as unknown as ReturnType<typeof useApi>);
});

afterEach(() => {
  vi.clearAllMocks();
});

// Finding: Maya DEEP_AUDIT_PM_FINDINGS.md 1b / Rohan DEEP_AUDIT_UX_FINDINGS.md
// L-4 (independently confirmed) — `useWorkflows.ts`'s `toggleWorkflow()` and
// `deleteWorkflow()` both optimistically mutate local state BEFORE calling the
// API, then `catch { /* optimistic */ }` on failure — there is no revert branch
// and no error surfaced to the caller/UI. A server-side failure (RBAC edge case,
// network blip, 500) leaves the UI showing the workflow as toggled/deleted while
// the backend row is untouched.
//
// These tests assert the FIX-SHAPED behavior a correctness fix must deliver —
// local state reverts to match the server's actual (unchanged) row, and the
// failure is surfaced via the hook's existing `error` field — so they are RED
// against the current `catch { /* optimistic */ }` implementation. That failure
// is the executable proof the defect is real: a fixed hook would make both
// tests pass without needing any additional test to "prove itself twice."
describe('useWorkflows — toggleWorkflow must revert on API failure (RED, proves 1b/L-4)', () => {
  it('reverts the optimistic status flip back to the server-confirmed value when the API call rejects', async () => {
    const workflow = makeWorkflow({ id: 'wf1', status: 'active' });
    mockListWorkflows.mockResolvedValue({ workflows: [workflow] });
    mockToggleWorkflow.mockRejectedValue(new Error('500 Internal Server Error'));

    const { result } = renderHook(() => useWorkflows());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.workflows.find((w) => w.id === 'wf1')?.status).toBe('active');

    await act(async () => {
      await result.current.toggleWorkflow('wf1');
    });

    // A correct implementation reverts the optimistic flip once the API call
    // rejects, since the backend row is still 'active'. Today's implementation
    // has no revert branch at all, so this fails — the workflow is left showing
    // 'paused' even though nothing changed server-side.
    expect(result.current.workflows.find((w) => w.id === 'wf1')?.status).toBe('active');
  });

  it('surfaces the failure via the hook error state instead of swallowing it', async () => {
    const workflow = makeWorkflow({ id: 'wf1', status: 'active' });
    mockListWorkflows.mockResolvedValue({ workflows: [workflow] });
    mockToggleWorkflow.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useWorkflows());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.toggleWorkflow('wf1');
    });

    // `catch { /* optimistic */ }` never touches `error` — a correct fix must
    // surface the failure somehow (reusing the existing `error` field is the
    // path of least resistance, matching how `load()` already does it).
    expect(result.current.error).not.toBeNull();
  });
});

describe('useWorkflows — deleteWorkflow must revert on API failure (RED, proves 1b/L-4)', () => {
  it('restores the workflow to local state when the API delete call rejects', async () => {
    const workflows = [makeWorkflow({ id: 'wf1' }), makeWorkflow({ id: 'wf2', name: 'Other' })];
    mockListWorkflows.mockResolvedValue({ workflows });
    mockDeleteWorkflow.mockRejectedValue(new Error('500 Internal Server Error'));

    const { result } = renderHook(() => useWorkflows());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.workflows).toHaveLength(2);

    await act(async () => {
      await result.current.deleteWorkflow('wf1');
    });

    // A correct implementation restores the optimistically-removed row once the
    // API call rejects, since the row still exists in Postgres. Today's
    // implementation has no restore branch, so this fails — the workflow stays
    // removed from the list even though the delete never actually happened.
    expect(result.current.workflows.some((w) => w.id === 'wf1')).toBe(true);
    expect(result.current.workflows).toHaveLength(2);
  });

  it('surfaces the failure via the hook error state instead of swallowing it', async () => {
    const workflows = [makeWorkflow({ id: 'wf1' })];
    mockListWorkflows.mockResolvedValue({ workflows });
    mockDeleteWorkflow.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useWorkflows());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.deleteWorkflow('wf1');
    });

    expect(result.current.error).not.toBeNull();
  });
});
