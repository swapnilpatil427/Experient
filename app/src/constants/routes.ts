// Single source of truth for all navigation route identifiers.
// Import ROUTES everywhere — never use raw string literals for page names.
export const ROUTES = {
  LANDING:            '/',
  SIGNIN:             '/signin',
  ONBOARDING:         '/onboarding',
  DASHBOARD:          '/app/dashboard',
  VISUAL_STUDIO:      '/app/visual',
  SURVEYS:            '/app/surveys',
  CREATE:             '/app/surveys/create',
  BUILDER:            '/app/surveys/:surveyId/build',
  RESPONSE_DASHBOARD: '/app/surveys/:surveyId/responses',
  SURVEY_INSIGHTS:    '/app/surveys/:surveyId/insights',
  SAMPLE_RESPONSES:   '/app/surveys/:surveyId/sample-responses',
  // Insight Pipeline v2 — Phase 4 Trail + report viewer
  INSIGHT_TRAIL:      '/app/surveys/:surveyId/intelligence/trail',
  INSIGHT_REPORT:     '/app/surveys/:surveyId/intelligence/reports/:reportId',
  // Insight Pipeline v2 — Phase 5 Settings + Phase 6 Custom Analysis
  INSIGHT_SETTINGS:   '/app/surveys/:surveyId/intelligence/settings',
  CUSTOM_ANALYSIS:    '/app/surveys/:surveyId/intelligence/custom',
  CUSTOM_REPORT:      '/app/surveys/:surveyId/intelligence/custom/:reportId',
  INSIGHTS:           '/app/insights',
  ADVANCED_INSIGHTS:  '/app/insights/advanced',
  INSIGHTS_BRIEF:     '/app/insights/brief',
  INSIGHTS_METRICS:   '/app/insights/metrics',
  INSIGHTS_FINDINGS:  '/app/insights/findings',
  INSIGHTS_SURFACED:  '/app/insights/surfaced',
  RESPONDENTS:        '/app/respondents',
  TEMPLATES:          '/app/templates',
  TEMPLATE_EDITOR:    '/app/templates/new',
  WORKFLOWS:          '/app/workflows',
  WORKFLOW_BUILD:     '/app/workflows/build',
  WORKFLOW_CANVAS:    '/app/workflows/canvas',
  WORKFLOW_NL_BUILD:  '/app/workflows/build/nl',
  ALERTS:             '/app/alerts',
  NOTIFICATION_PREFS:      '/app/settings/notifications',
  NOTIFICATION_ANALYTICS:  '/app/settings/notification-analytics',
  SETTINGS:           '/app/settings',
  BILLING:            '/app/settings/billing',
  SETTINGS_USERS:       '/app/settings/users',
  SETTINGS_ROLES:       '/app/settings/users/roles',
  SETTINGS_DEPARTMENTS: '/app/settings/users/departments',
  SETTINGS_GROUPS:      '/app/settings/users/groups',
  SETTINGS_PROVISIONING: '/app/settings/users/provisioning',
  SETTINGS_SEATS:        '/app/settings/users/seats',
  SETTINGS_AUDIT:        '/app/settings/users/audit',
  SETTINGS_TAGS:         '/app/settings/tags',
  SETTINGS_INTEGRATIONS: '/app/settings/integrations',
  DATA:               '/app/data',

  // Prism — data ingestion / migration wizard
  PRISM:              '/app/prism',
  PRISM_CONNECT:      '/app/prism/connect/:platform',
  PRISM_JOB:          '/app/prism/jobs/:jobId',
  PRISM_JOBS:         '/app/prism/jobs',
  EXPERIENCE:                  '/app/experience',
  EXPERIENCE_ORG_TRENDS:       '/app/experience/org/trends',
  EXPERIENCE_TOPICS:           '/app/experience/topics',
  EXPERIENCE_SURVEY:           '/app/experience/survey/:surveyId',
  EXPERIENCE_SURVEY_REPORT:    '/app/experience/survey/:surveyId/report',
  EXPERIENCE_SURVEY_TOPICS:    '/app/experience/survey/:surveyId/topics',
  EXPERIENCE_SURVEY_TOPIC:     '/app/experience/survey/:surveyId/topics/:topicId',
  EXPERIENCE_SURVEY_TRENDS:    '/app/experience/survey/:surveyId/trends',
  GROUP_REPORT:        '/app/groups/:tagId/report/:runId',
  GROUP_REPORT_LATEST: '/app/groups/:tagId/report',

  // Tag Report — cross-survey AI insight rollups, nested under Experience
  // (DESIGN.md Appendix C: dedicated sub-route, not a top-level nav item nor
  // a tab inside ExperienceHubPage).
  TAG_REPORTS_INDEX:  '/app/experience/reports',
  TAG_REPORT_NEW:     '/app/experience/tags/:tagId/report/new',
  TAG_REPORT_LATEST:  '/app/experience/tags/:tagId/report',
  TAG_REPORT:         '/app/experience/tags/:tagId/report/:runId',
  TAG_REPORT_TRAIL:   '/app/experience/tags/:tagId/report/trail',

  // Response Detail — R-T5 audit-trail terminus (survey-scoped, matches how
  // response data is scoped elsewhere).
  RESPONSE_DETAIL: '/app/surveys/:surveyId/responses/:responseId',

  // Admin — Crystal
  ADMIN_CRYSTAL:              '/app/admin/crystal',
  ADMIN_CRYSTAL_SKILLS:       '/app/admin/crystal/skills',
  ADMIN_CRYSTAL_SKILL_DETAIL: '/app/admin/crystal/skills/:skillName',
  ADMIN_CRYSTAL_QUALITY:      '/app/admin/crystal/quality',
  ADMIN_CRYSTAL_SIGNALS:      '/app/admin/crystal/signals',
  ADMIN_CRYSTAL_GAPS:         '/app/admin/crystal/gaps',
  ADMIN_CRYSTAL_DLQ:          '/app/admin/crystal/dlq',

  // Tier 3 — Closed-Loop Action Platform
  CONTACTS:              '/app/contacts',
  CONTACT_DETAIL:        '/app/contacts/:contactId',
  CONTACT_SEGMENTS:      '/app/contacts/segments',
  CASES:                 '/app/cases',
  CASE_DETAIL:           '/app/cases/:caseId',
  SETTINGS_OWNERSHIP:    '/app/settings/ownership',
  SETTINGS_ONTOLOGY:     '/app/settings/ontology',
  SETTINGS_CONNECTIONS:  '/app/settings/connections',

  // Broadcasts (Tier 3 Phase J)
  BROADCASTS:            '/app/broadcasts',
  BROADCASTS_APPROVAL:   '/app/broadcasts/approval',

  // Support System
  SUPPORT_ROOT:               '/app/support',
  SUPPORT_DOCS:               '/app/support/docs',
  SUPPORT_DOC:                '/app/support/docs/:key',
  SUPPORT_CHANGELOG:          '/app/support/changelog',
  SUPPORT_ROADMAP:            '/app/support/roadmap',
  SUPPORT_STATUS:             '/app/support/status',

  // Admin — Support Pipeline
  ADMIN_SUPPORT_PIPELINE:     '/app/admin/support/pipeline',
  ADMIN_SUPPORT_REVIEW:       '/app/admin/support/review/:docId',
  ADMIN_SUPPORT_EDIT:         '/app/admin/support/edit/:docId',
  ADMIN_SUPPORT_GAPS:         '/app/admin/support/gaps',
  ADMIN_SUPPORT_STATS:        '/app/admin/support/stats',
};

/** Replace :param placeholders with concrete values */
export function toPath(route: string, params: Record<string, string> = {}) {
  return Object.entries(params).reduce(
    (p, [k, v]) => p.replace(`:${k}`, String(v)),
    route
  );
}
