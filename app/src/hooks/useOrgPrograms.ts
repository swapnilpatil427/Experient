// useOrgPrograms — pagination/sort/filter state + fetch for ProgramsTable.
// Client-side sort/pagination is handled by ProgramsTable itself for <=50
// rows (per DESIGN.md §5's "Sort behavior"); this hook owns the state that
// crosses that threshold (triggers a new API call with sort/order/page).

import { useCallback, useState } from 'react';
import { useApi } from './useApi';
import { useFetch } from './useExperience';
import type { ProgramsSortKey, SortOrder, HealthStatus } from '../types/orgDashboard';

export function useOrgPrograms() {
  const api = useApi();
  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState<10 | 25 | 50>(25);
  const [sort, setSort]         = useState<ProgramsSortKey>('health');
  const [order, setOrder]       = useState<SortOrder>('asc');
  const [tagId, setTagId]       = useState<string | undefined>(undefined);
  const [status, setStatus]     = useState<HealthStatus | undefined>(undefined);

  const fetcher = useCallback(
    () => api.getOrgDashboardPrograms({ page, pageSize, sort, order, tagId, status }),
    [api, page, pageSize, sort, order, tagId, status],
  );
  const result = useFetch(fetcher);

  const toggleSort = useCallback((key: ProgramsSortKey) => {
    setSort((prevKey) => {
      if (prevKey === key) {
        setOrder((prevOrder) => (prevOrder === 'asc' ? 'desc' : 'asc'));
        return prevKey;
      }
      setOrder('asc');
      return key;
    });
  }, []);

  return {
    ...result,
    page, setPage,
    pageSize, setPageSize,
    sort, order, toggleSort,
    tagId, setTagId,
    status, setStatus,
  };
}
