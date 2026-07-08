# Team: Tag Report

## Mission
Let orgs tag survey responses — manually and via AI-assisted suggestions — and roll those tags into a Tag Report that surfaces frequency, sentiment, and trend-by-tag, so the people who own CX/VoC outcomes can act on recurring themes.

## Members

### Product Owner — Morgan
**Owns:** `docs/tag-report/DESIGN.md`, requirements + acceptance criteria, success metrics, `docs/TRACKER.md` updates
**Layer:** docs
**Skills:** Product strategy, XM/VoC domain knowledge, requirements writing

### Tech Lead / Architect — Devon
**Owns:** Tag data model contract (shared by backend/frontend/crystalos), API contract definitions, seam-consistency review across layers
**Layer:** cross-layer
**Skills:** System design, Postgres schema design, API contract design

### Backend Engineer — Alex
**Owns:** `tags` / `tag_assignments` migrations, Express CRUD + assignment endpoints, report aggregation queries, rate limiting
**Layer:** backend
**Skills:** TypeScript, SQL, REST API design, pg

### Applied Scientist / CrystalOS Engineer — Priya
**Owns:** Auto-tag suggestion skill (LangGraph node), tagging model eval harness (`EVALS.md`), precision/recall benchmarks, `SKILL.md`
**Layer:** crystalos
**Skills:** Python, FastAPI, LangGraph, NLP/classification, LLM eval design

### Frontend Engineer — Jordan
**Owns:** Tag management UI, Tag Report dashboard (frequency/sentiment/trend views), locales keys, DataBus invalidation
**Layer:** frontend
**Skills:** React 19, TypeScript, Tailwind v4, Recharts, shadcn/UI

### UX Researcher / Designer — Sam
**Owns:** Tag Report UX flows + wireframes, moderated usability sessions with real customers, synthesis of customer feedback into design revisions
**Layer:** docs (design)
**Skills:** UX research, interaction design, usability testing

### Security Reviewer — Riley
**Owns:** Security review of tag data handling (PII exposure in free-text tags, org-scoping, access control on report data), sign-off before launch
**Layer:** qa
**Skills:** AppSec review, data privacy, RBAC auditing

### QA Engineer — Casey
**Owns:** Test plan, edge-case matrix, integration tests, regression checklist, launch readiness verdict
**Layer:** qa
**Skills:** Test strategy, API testing, risk analysis

### Customer Advisory Reviewer — TBD (external, not an agent)
**Owns:** Reviews prototypes and the shipped feature as an actual user; tells us whether tag-based insights are genuinely actionable
**Layer:** docs
**Skills:** Represents a real customer/beta org
**Agent:** none — human reviewer, not dispatched as an AI agent

### Business Stakeholder / Executive Sponsor — TBD (external, not an agent)
**Owns:** Defines what "actionable insight" means for the business, reviews Tag Report output against real decisions, final go/no-go sign-off
**Layer:** docs
**Skills:** CX/VoC leadership, business-outcome framing
**Agent:** none — human reviewer, not dispatched as an AI agent

## Coordination
- Product Owner's `DESIGN.md` must exist and be reviewed before Tech Lead locks the tag data model contract.
- Backend's schema must be finalized before Frontend wires the Tag Report UI or CrystalOS builds the auto-tag skill — they consume the same contract.
- UX Researcher runs customer sessions against a working Frontend prototype, not raw wireframes.
- Security Reviewer and the two external reviewers (Customer, Business Stakeholder) gate final launch — their sign-off runs after all engineering members complete their scope, not in parallel with it.
