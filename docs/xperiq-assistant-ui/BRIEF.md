# Brief — Minimal assistant-ui adoption for Crystal chat

## Why this branch exists

Xperiq is an AI survey/experience-management platform. "Crystal" is its AI copilot,
today a hand-built chat panel (`app/src/components/CrystalPanel.tsx`) with **no
message-history persistence at all** — refresh the page, the conversation is gone,
and there's no concept of multiple parallel conversations ("threads").

A previous, much larger effort (see `docs/harness-engineering/assistant-ui-migration/`
on the `assistant-ui-migration` branch — read `FINDINGS.md` and `TRACKER.md` there for
full history) tried to reimplement Crystal's entire chat UI pixel-for-pixel using
`@assistant-ui/react`, by hand-composing every primitive to match the old design. It
was rolled back — partly because "rebuild everything by hand" defeated the point of
adopting a library, and it never actually delivered the one thing the library is
genuinely good at: thread/history management.

**This pass is deliberately different and deliberately minimal**: use assistant-ui's
own default-styled components as-is (not a custom pixel-matched rebuild), wire them to
the *existing* Crystal REST endpoint (zero CrystalOS/backend changes), and add a
`localStorage`-backed thread list — a real, visible upgrade (multiple named
conversations, survives page refresh) that Crystal has never had, achievable in the
frontend alone.

## Explicit scope boundaries

- **In scope**: a new, small chat surface (new component(s) under
  `app/src/components/assistant-ui-minimal/` or similar — pick a sensible name that
  doesn't collide with anything), using assistant-ui's stock `Thread`/`ThreadList`/
  `Composer` look (Tailwind-themeable via Xperiq's existing CSS custom-property brand
  system — see `app/CLAUDE.md`'s "Brand Theme System" section — do NOT hardcode
  assistant-ui's default color palette; wire `--color-primary`/`--color-tertiary` etc.
  the same way the rest of the app does).
- **Out of scope, do not touch**: `crystalos/` (CrystalOS/Python), any
  `backend/src/routes/*.ts` file, any new Postgres migration, any change to the
  *existing* `CrystalPanel.tsx` (it can stay exactly as-is — this is a **new, separate,
  parallel surface** for now, not a replacement — mount it behind a new dev-only route
  like the original G0 spike used, e.g. `/dev/crystal-assistant-ui`, gated on
  `import.meta.env.DEV`, so it never reaches a real customer by accident this pass).
- **Persistence reality check (already researched, don't re-litigate)**: assistant-ui
  does not persist anything server-side unless you use their hosted "Assistant Cloud"
  (a third-party SaaS — do not use it; Xperiq is an enterprise B2B survey platform,
  routing customer chat data through a third-party cloud is a real data-residency
  decision that needs an explicit go-ahead, not something to adopt as a side effect of
  a UI experiment). Use an `ExternalStoreThreadListAdapter` backed by `localStorage`
  instead — real persistence (survives refresh), zero backend dependency, zero
  third-party data flow. A future phase can swap this adapter for a real
  backend-owned one (Xperiq already has a `crystal_threads` table and a documented
  `crystal_threads_v2` plan) without touching the UI layer above it.

## Technical shape (a starting point, not gospel — use engineering judgment)

- **Chat model**: wire to the existing REST endpoint the app already calls —
  `useApi().crystalChat2(message, { surveyId, focusedTopic, conversationHistory })`
  (see `app/src/lib/api.ts`) — via assistant-ui's `useLocalRuntime` +
  a `ChatModelAdapter`. Non-streaming REST is fine for this minimal pass; do not
  attempt to wire the SSE streaming endpoint (`/api/experience/:scope/crystal/stream`)
  unless it turns out to be trivial — correctness and scope discipline matter more
  than feature parity here.
- **Thread list**: `ExternalStoreThreadListAdapter` (per assistant-ui's docs at
  https://www.assistant-ui.com/docs/runtimes/concepts/threads and
  https://www.assistant-ui.com/docs/runtimes/pick-a-runtime — fetch these directly,
  don't guess the API shape) storing an array of `{ id, title, messages }` threads in
  `localStorage` under a namespaced key (e.g. `xperiq.crystal.threads.v1`). New
  thread, rename, delete, switch — all client-side, no network calls beyond the chat
  model itself.
- **Auth/scope context**: reuse `useAppAuth()`/`useApi()` exactly as the rest of the
  app does — no new auth mechanism.
- **Styling**: Tailwind v4 + Xperiq's CSS custom properties (`var(--color-primary)`
  etc.) — see `app/CLAUDE.md`. Do not hand-roll a from-scratch visual design; lean on
  assistant-ui's own default component shapes and just theme the colors/fonts.

## What "done" looks like

1. `npx tsc --noEmit`, `npm run lint`, `npx vitest run` all clean.
2. A new test file (or files) covering: sending a message calls `crystalChat2` with
   the right args, a new thread can be created/switched/renamed/deleted, thread state
   survives a simulated remount (proving the localStorage adapter actually persists).
3. A short written note (append to this file or a new `RESULT.md` in this same
   folder) on: what assistant-ui gave you for free vs. what you had to build, and
   your honest opinion on whether this is worth pursuing further given what you saw
   building it.

## Reference material (read, don't re-derive from scratch)

- `docs/harness-engineering/assistant-ui-migration/` (on the `assistant-ui-migration`
  branch, not this one — use `git show assistant-ui-migration:docs/harness-engineering/assistant-ui-migration/<file>`
  to read specific files without switching branches) — `FINDINGS.md`,
  `ASSESSMENT_CRYSTALOS.md`, `CURRENT_STATE.md` in particular have real prior
  learnings about assistant-ui's API surface and pitfalls (e.g. `unstable_` API
  churn risk — see whatever guard/isolation pattern that effort used).
- `app/CLAUDE.md` — brand theming, testing conventions, Tailwind patterns.
- `app/src/lib/api.ts` — the real `crystalChat2` signature and response shape.
