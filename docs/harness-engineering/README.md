# Harness Engineering — Research & Planning Index

Three sub-areas, each a distinct phase of work studying agent-harness architecture
patterns and applying them to CrystalOS/Crystal. Brought over from the
`assistant-ui-migration` branch as reference material — no code, docs only.

## `external-repo-research/`
Deep-dive notes from studying four external repos for harness/agent-architecture
patterns (`awesome-harness-engineering`, `cme-langgraph-service`,
`qualtrics-agent-harness`, `qualtrics-agent-skills`) — reference material only, never
imported as code or skill content into CrystalOS. Start at `00-SYNTHESIS.md`.

## `rearchitecture-assessment/`
A 5-person expert-team assessment of whether CrystalOS should be rebuilt using the
patterns found in `external-repo-research/` — explicitly scoped to Xperiq-specific
skills/functions only, no Qualtrics branding or skill content carried over into
CrystalOS itself. Kept here as reference/research only. Start at `BRIEF.md` for the
assignment, `RECOMMENDATION.md`/`RECOMMENDATION_ROUND2.md` for the conclusions,
`findings-*.md` for each persona's detailed analysis.

## `assistant-ui-migration/`
Planning and execution tracking for evaluating (and ultimately rolling back)
`@assistant-ui/react` as Crystal's chat UI. See `TRACKER.md` for the full history,
including the decision to retire the assistant-ui chassis entirely and keep only the
CrystalOS harness improvements plus the legacy chat panel (this branch).
