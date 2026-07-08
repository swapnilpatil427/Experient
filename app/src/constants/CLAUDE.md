# Constants — Single Source of Truth

All constants files are TypeScript (`.ts`). Never use raw string literals for
routes, colors, or question types in components/pages — import the constant.

## routes.ts — ROUTES object
All app routes as named constants. Always import `ROUTES` and use `ROUTES.SURVEYS`;
use `toPath(ROUTES.BUILDER, { surveyId: id })` for parameterized routes. Every
authenticated route is `/app`-prefixed. For programmatic navigation use
`useNavigate()` + `toPath` — **never** `window.location.href` (full reload drops
SPA state incl. the Crystal panel).

Route groups (see `routes.ts` for the authoritative list — keep this in sync):
- Surveys: `SURVEYS`, `CREATE`, `BUILDER`, `RESPONSE_DASHBOARD`, `SAMPLE_RESPONSES`
- Insights: `INSIGHTS`, `ADVANCED_INSIGHTS`, `SURVEY_INSIGHTS`, `INSIGHTS_BRIEF/METRICS/FINDINGS/SURFACED`, `DASHBOARD`, `VISUAL_STUDIO`
- Experience: `EXPERIENCE_TOPICS` (cross-survey topics analysis), `EXPERIENCE_SURVEY` (+ `_REPORT/_TOPICS/_TOPIC/_TRENDS`), `GROUP_REPORT*`
- Tag Report (nested under Experience): `TAG_REPORTS_INDEX`, `TAG_REPORT_NEW`, `TAG_REPORT_LATEST`, `TAG_REPORT`, `TAG_REPORT_TRAIL`, `RESPONSE_DETAIL`
- Automation: `WORKFLOWS`, `WORKFLOW_BUILD`, `WORKFLOW_CANVAS`, `ALERTS`, `NOTIFICATION_PREFS`
- Library/data: `TEMPLATES`, `TEMPLATE_EDITOR`, `RESPONDENTS`, `DATA`
- Settings: `SETTINGS`, `SETTINGS_USERS/ROLES/DEPARTMENTS/GROUPS/PROVISIONING/SEATS/AUDIT/TAGS`
- Admin (Crystal): `ADMIN_CRYSTAL*` (skills, quality, signals, gaps, dlq, skill detail)
- Public: `LANDING`, `SIGNIN`, `ONBOARDING`

## colors.ts — GRADIENTS, BADGES, SENTIMENT_COLORS
Color palettes for survey types, sentiment indicators, gradients.

## questionTypes.ts — QTYPE_META, QTYPE_GROUPS
Survey question type metadata (icon, label, group). Use the `createQuestion(typeKey)` factory.

## surveyTypes.ts — SURVEY_CATEGORIES
Survey category types (NPS, CSAT, Product Feedback, …) with descriptions.

## thresholds.ts — NPS, SENTIMENT, CSAT
Score interpretation thresholds for NPS, CSAT, and sentiment.
