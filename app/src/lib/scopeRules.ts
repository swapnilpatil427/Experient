// Frontend mirror of backend/src/schemas/workflows.ts's SCOPE_UNSUPPORTED_TRIGGER_TYPES
// (docs/automation-hub/BUILDER_REDESIGN_V2_SCOPE.md §2 / BUILDER_REDESIGN_V2_CONCEPT.md
// §3, updated Wave 7). `time.schedule` DOES support survey/tag scope now — scope
// drives what data a scheduled digest fetches to summarize (see backend's
// fetchScheduledSurveyMetrics), not event-matching. `external.webhook` remains
// excluded: an inbound webhook carries its own event payload and has no comparable
// content-generation use case for scope. Keep in sync with the backend set by hand
// (asserted by src/__tests__/lib/scopeRules.test.ts).
export const SCOPE_UNSUPPORTED_TRIGGER_TYPES = new Set(['external.webhook']);
