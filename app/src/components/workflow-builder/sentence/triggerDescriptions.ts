// One-line plain-English descriptions per trigger type, authored by hand
// (BUILDER_REDESIGN_V2_CONCEPT.md §4 — "you'll need to author these... put
// them in a local const map, not fabricated per-render"). Keys mirror the
// real registry's `type` strings exactly (backend/src/lib/workflowRegistry.ts).
export const TRIGGER_DESCRIPTIONS: Record<string, string> = {
  'survey.response_received': 'Fires every time a new response comes in for a survey.',
  'survey.response_filtered': 'Fires when a response matches specific filter criteria you define.',
  'survey.milestone': 'Fires when a survey crosses a response-count milestone (e.g. 100 responses).',
  'score.nps_drop': "NPS dropped — fires when a response's NPS score is lower than a threshold you set.",
  'score.nps_rise': "NPS rose — fires when a response's NPS score is higher than a threshold you set.",
  'crystal.insight_ready': 'Fires when Crystal finishes generating new insights for a survey.',
  'crystal.anomaly_detected': 'Fires when Crystal detects an unusual pattern or outlier in the data.',
  'crystal.verbatim_escalation': 'Fires when Crystal flags a verbatim response as urgent or high-severity.',
  'crystal.sentiment_spike': 'Fires when Crystal detects a sudden shift in sentiment.',
  'crystal.new_theme_detected': 'Fires when Crystal identifies a new recurring theme in responses.',
  'alert.fired': 'Fires whenever one of your configured alerts triggers.',
  'time.schedule': 'Fires on a recurring schedule you define, like every Monday morning.',
  'external.webhook': 'Fires when an inbound webhook call is received from an external system.',
};

export function triggerDescription(type: string): string {
  return TRIGGER_DESCRIPTIONS[type] ?? '';
}
