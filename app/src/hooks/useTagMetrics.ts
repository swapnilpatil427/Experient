// useTagMetrics — tag-scoped aggregates (survey_tags-keyed), backing both
// the Hub's TagGroupsStrip (at-risk only, filtered client-side per
// Decision 18's data-layer-scoping condition — see TagGroupsStrip.tsx for
// where that filter is actually enforced) and the full-page TagIntelligenceGrid.

import { useCallback } from 'react';
import { useApi } from './useApi';
import { useFetch } from './useExperience';

export function useTagMetrics() {
  const api = useApi();
  const fetcher = useCallback(() => api.getOrgTagMetrics(), [api]);
  return useFetch(fetcher);
}
