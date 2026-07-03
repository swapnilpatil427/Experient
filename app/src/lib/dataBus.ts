// Lightweight cross-component invalidation bus.
//
// The app has no shared query cache — each page hook owns its own copy of
// server data. When Crystal (the global panel) mutates data via the API, the
// open pages don't know. This bus lets a mutation announce "this resource
// changed" and lets page hooks re-fetch in response.
//
// Usage:
//   import { invalidate, useInvalidation } from '../lib/dataBus';
//   invalidate('workflows');                          // after a mutation
//   useInvalidation('workflows', reload);             // in a data hook

import { useEffect } from 'react';

export type DataResource = 'workflows' | 'alerts' | 'insights' | 'surveys' | 'cases' | 'contacts' | 'ontology' | 'broadcasts' | 'credits' | 'prism' | 'tagReports';

const EVENT = 'crystal:data-changed';

/** Announce that a resource changed so any subscribed hook re-fetches. */
export function invalidate(resource: DataResource): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<DataResource>(EVENT, { detail: resource }));
}

/** Subscribe a data hook to invalidation events for a resource. */
export function useInvalidation(resource: DataResource, onInvalidate: () => void): void {
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<DataResource>).detail;
      if (detail === resource) onInvalidate();
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, [resource, onInvalidate]);
}
