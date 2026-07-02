import { useState, useEffect, useCallback } from 'react';
import type { Workflow } from '../types';
import { useApi } from './useApi';
import { invalidate, useInvalidation } from '../lib/dataBus';

const MOCK_WORKFLOWS: Workflow[] = [
  { id: 'w1', name: 'Critical Alert',         condition: { field:'sentiment',operator:'=',value:'Negative' }, action: { type:'email',  config:{ to:'support@company.com' } },  status: 'active', trigger_count: 48  },
  { id: 'w2', name: 'Feature Request Tagger', condition: { field:'topic',   operator:'=',value:'Feature Request' }, action: { type:'tag',    config:{ tag:'feature-request' } },  status: 'active', trigger_count: 156 },
  { id: 'w3', name: 'Retention Watch',        condition: { field:'nps',     operator:'<',value:'6' },           action: { type:'notify', config:{ team:'customer-success' } }, status: 'paused', trigger_count: 12  },
];

export function useWorkflows() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading,   setLoading]   = useState<boolean>(true);
  const [error,     setError]     = useState<string | null>(null);
  const api = useApi();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { workflows } = await api.listWorkflows();
      setWorkflows(workflows);
      setError(null);
    } catch (err) {
      // Keep the page usable offline/in demo mode, but still surface the error
      // so the UI can show a banner rather than silently showing mock data.
      setWorkflows(MOCK_WORKFLOWS);
      setError(err instanceof Error ? err.message : 'Failed to load workflows');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  // Re-fetch when Crystal (or anything else) creates/changes a workflow.
  useInvalidation('workflows', load);

  const createWorkflow = useCallback(async (data: Partial<Workflow>): Promise<Workflow> => {
    try {
      const result = await api.createWorkflow(data);
      setWorkflows((prev) => [result.workflow, ...prev]);
      invalidate('workflows');
      return result.workflow;
    } catch {
      const mock: Workflow = { id: `w${Date.now()}`, name: '', condition: {}, action: {}, status: 'active', trigger_count: 0, ...data } as Workflow;
      setWorkflows((prev) => [mock, ...prev]);
      return mock;
    }
  }, [api]);

  const toggleWorkflow = useCallback(async (id: string): Promise<void> => {
    // Optimistic flip — reverted below if the API call rejects, since the
    // server-side row is the only source of truth (Maya 1b / Rohan L-4:
    // `catch { /* optimistic */ }` used to leave the UI showing the toggle
    // succeeded even when the backend row never changed).
    const previousStatus = workflows.find((w) => w.id === id)?.status;
    setWorkflows((prev) =>
      prev.map((w) => w.id === id ? { ...w, status: (w.status === 'active' ? 'paused' : 'active') as Workflow['status'] } : w)
    );
    try {
      const { status } = await api.toggleWorkflow(id);
      // Reconcile with the server's actual result (e.g. if it wasn't 'active').
      setWorkflows((prev) => prev.map((w) => w.id === id ? { ...w, status: status as Workflow['status'] } : w));
      setError(null);
    } catch (err) {
      // Revert the optimistic flip — the backend row never changed.
      if (previousStatus) {
        setWorkflows((prev) => prev.map((w) => w.id === id ? { ...w, status: previousStatus } : w));
      }
      setError(err instanceof Error ? err.message : 'Failed to update workflow status');
    } finally {
      invalidate('workflows');
    }
  }, [api, workflows]);

  const deleteWorkflow = useCallback(async (id: string): Promise<void> => {
    // Optimistic removal — restored below if the API call rejects (Maya 1b /
    // Rohan L-4: previously the row stayed removed from the list even though
    // the delete never actually happened server-side).
    const previousWorkflows = workflows;
    const removedIndex = previousWorkflows.findIndex((w) => w.id === id);
    setWorkflows((prev) => prev.filter((w) => w.id !== id));
    try {
      await api.deleteWorkflow(id);
      setError(null);
    } catch (err) {
      if (removedIndex !== -1) {
        setWorkflows((prev) => {
          const next = [...prev];
          next.splice(removedIndex, 0, previousWorkflows[removedIndex]);
          return next;
        });
      }
      setError(err instanceof Error ? err.message : 'Failed to delete workflow');
    } finally {
      invalidate('workflows');
    }
  }, [api, workflows]);

  const testWorkflow = useCallback(async (id: string) => {
    const { result } = await api.testWorkflow(id);
    return result;
  }, [api]);

  return { workflows, loading, error, createWorkflow, toggleWorkflow, deleteWorkflow, testWorkflow, reload: load };
}
