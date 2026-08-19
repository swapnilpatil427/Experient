# Crystal → assistant-ui: Execution Tracker

> **Status:** Planning complete (see `MIGRATION_PLAN.md`). Execution started 2026-08-06.
> **Re-charter:** `TEAM.md`'s pod was chartered planning-only ("not authorized to write production code").
> Planning is signed off, so the same four personas (Nadia/frontend, Theo/design-system,
> Priya/crystalos+contract, Sam/QA-release) are re-chartered for **implementation**, scoped to
> P0 → G1 per this tracker. Their planning mandates in `TEAM.md` are historical context, not
> the current charter — this file is the current charter.

## Decisions applied this session (2026-08-06)

1. **Scope = "execute everything buildable now."** P0 blockers, G0 spike, G1 contract fixes are
   in scope for immediate implementation. **G2–G4 are queued, not implemented** — they sit behind
   two hard calendar waits that no engineering effort shortens: a ≥2-week live funnel baseline
   (after the P0-3 funnel fix ships) and a 30-day fallback-panel retention after cutover
   (`MIGRATION_PLAN.md` §1, §5). Do not mark G2+ "done" by writing code that skips these waits.
2. **The 6 open product decisions (`MIGRATION_PLAN.md` §7) use the pod's implied defaults**,
   not fresh product sign-off. Each is flagged below so it can be revisited:
   - #1 (viz required vs. permitted): defaulted to **required-when-citing-a-metric-insight**,
     paired with decision below, so the widget path is guaranteed to get exercised.
   - #2 (chart tier): **Tier-0, deterministic server-side** — backend decides when to emit a
     chart, not the model. Cheaper, and avoids the failure mode where a model-chosen chart
     never fires.
   - #3 (G3 slice ordering): not yet relevant — G3 is queued behind the calendar gates.
   - #4 (funnel drop acknowledged): accepted — P0-3's fix will visibly change reported proposal
     accept rates. Expected, not a regression.
   - #5 (copilot PII policy): left **unchanged** — no `user_role` remediation is in scope this
     pass. The privilege-escalation finding (`MIGRATION_PLAN.md` §8) is separate from this
     migration and not fixed here.
   - #6 (cosmetic/platform choices — composer border, `tw-animate-css`, `text-[10px]` scale):
     deferred to G3, not decided.
3. **First generative-UI widget = Tier-0 NPS chart**, deterministic, server-emitted `viz` spec,
   frontend-resolved against a Recharts-backed component registry. This is the foundation for
   "add a widget later" — the registry is the extension point for future widget types, not a
   one-off chart hack.

## Phase status

| Phase | Item | Status | Notes |
|---|---|---|---|
| P0 | #1 EVALS `non_empty` scorer fix | in progress | crystalos/lib/skill_runtime.py |
| P0 | #2 CSS-cascade invariant test + token-guard fix | in progress | app/ tests |
| P0 | #3 Funnel upsert bug fix + pinning-test rewrite | in progress | backend/ + new migration |
| P0 | Registry-hygiene guard test | **done** | `crystalIdentityTokens.test.ts` extended to walk `src/components/assistant-ui/**` + `src/components/crystal/**` |
| G0 | assistant-ui frontend spike (adapter + shell) | **done** | `@assistant-ui/react@0.15.5` pinned exact; adapter 240 LOC (≤500 gate); `ExternalStoreRuntime`; unmodified `CrystalThinkingBubble`(now exported)+`ActionProposalCard` render inside `ThreadPrimitive`; two-turn citation retro-enrichment test passes; not wired into production render path |
| G0 | Generative-UI viz contract + Tier-0 NPS chart | **done** | `VizSpec`/`_build_viz_for_citations` in `crystalos/agents/crystal.py`; wired through all 4 SSE emission sites + REST; backend `crystalHandler`/`insights.ts` allowlist bug fixed (was silently dropping unrecognized SSE fields incl. `viz`); frontend `CRYSTAL_VIZ_REGISTRY` (one entry, `nps_bar_chart`→Recharts) is the "add a widget later" extension point — contract shapes cross-checked byte-for-byte, match exactly |
| G1 | message_id/turn_id on wire, server-minted proposal IDs | **done** | `turn_id` minted synchronously pre-emission in all 4 CrystalOS entry points, threaded into `answer` SSE/REST + `crystal_turn_events.id` (explicit INSERT, bypasses `DEFAULT gen_random_uuid()`); proposal `id` now `{turn_id}:{slug}` (unique per turn, still stable across one card's emitted→accepted→succeeded lifecycle, preserves P0-3 dedup) |
| G1 | `XperiqCopilot` convergence step 1 (Escape-to-close, aria-labels ported up) | **done** | Ported into `CrystalPanel.tsx` (Escape-to-close, close/send aria-labels) + `AppShell.tsx` (open-trigger FAB aria-label, was hardcoded, now `t()`-ed) — no flag, per plan resolution. `aria-live` region evaluated and deliberately **not shipped** — collides with ~8 pinned test assertions; flagged as a follow-up, not silently dropped |
| G2 | `XperiqCopilot` convergence (Phase A) | **done** | `SurveyBuilderPage.tsx` now wires `useCrystalPanel()` directly (`builderContext`, `builderChatHandler`, `builderQuestionsHydrator`, `builderRecommendationHandler`); `ExperientCopilot.tsx` no longer mounted as an independent chat chassis (file still exists, deletion is a follow-up step); `AppShell.tsx`'s 3 suppression conditions removed |
| G2→cutover | `crystal_chassis` flag **built, then explicitly retired same-day** | **done** | Built as a per-org `'legacy'\|'assistant_ui'` rollout flag with a DEV-only VITE override, per the original calendar-gated G2→G3→G4 plan below. **Product-owner decision (2026-08-18): skip the gate.** Explicit ask — "enable it for all brands for now... remove this flag" (any dev mode, fully-remove-the-flag scope confirmed via clarifying question, not assumed) — assistant-ui is now the only chassis, unconditionally, for every org. The flag/column/resolver/ternary are deleted, not just defaulted — see "assistant-ui is now the only chassis" below for what that took. |
| G2 | `CrystalPanelAUI` — the sole Crystal panel | **done** | `app/src/components/assistant-ui/CrystalPanelAUI.tsx` — same `CrystalPanelProps` the retired `CrystalPanel.tsx` had, same `useCrystalPanel()`/`useCrystalConversation()` consumption and panel chrome, renders `CrystalThreadShell` for the conversation body; proposals attach to the message that produced them (ported from `CrystalThreadShellDevPage.tsx`'s proven adapter). `AppShell.tsx` mounts it unconditionally — no ternary, no flag. |
| G2 | Known gap (not silently dropped) | **open** | `CrystalThreadShell`'s message rendering has no thumbs/pin/create-ticket buttons or the support-mode escalation CTA yet — none are exercised by the I1–I6 funnel invariants this migration's own test plan defines; this is now a live customer-facing gap (not a deferred-behind-a-flag one), tracked as a follow-up |
| G2 | Funnel-invariant (I1–I6) + dual-chassis (`describe.each`) test suite | **moot** | Was written for a dual-chassis rollout that no longer exists — there's only one chassis now. Not needed. |
| G2 | `axe-core` a11y assertion | **not started** | Still worth doing against the single remaining chassis |
| — | Thread persistence, Tier-1 charts | **not started, not gated** | No longer calendar-gated (there's no live funnel baseline being protected — the flag that existed to protect it is gone) — just not yet built. Pick up whenever. |

### assistant-ui is now the only chassis (2026-08-18)

Per the product-owner decision above, `CrystalPanel.tsx` (the legacy hand-rolled panel, ~2100 LOC)
is **deleted**, not just unmounted. What that required, so a future reader isn't confused by the
gap between this and the original G2–G4 plan further down this file:

- **Shared UI extracted first**: `CrystalThinkingBubble`, `ActionProposalCard`,
  `AppliedFiltersDisclosure` (both chassis' shared, byte-identical building blocks) and
  `classifyAsSupport` (+ its `ENUMERATION_PATTERNS`/`DATA_OBJECT_EXCLUSIONS`) moved out of
  `CrystalPanel.tsx` into `app/src/components/crystal/sharedUi.tsx` before the delete — `CrystalThreadShell.tsx`
  and `CrystalPanelAUI.tsx` both import from there now, not from the deleted file.
- **`AppShell.tsx`**: the `crystalChassis === 'assistant_ui' ? <CrystalPanelAUI/> : <CrystalPanel/>`
  ternary became an unconditional `<CrystalPanelAUI/>` mount; `useBrand()` no longer has a
  `crystalChassis` field.
- **Flag mechanism deleted**: `app/src/lib/flags/crystalChassis.ts`, its test, the
  `org_profiles.crystal_chassis` column provisioning in `backend/src/routes/orgProfile.ts`
  (existing dev DBs that already ran the old `ALTER TABLE ADD COLUMN` keep an inert, harmless
  column — not worth a `DROP COLUMN` migration for), the never-applied
  `supabase/migrations/20260818000001_org_profiles_crystal_chassis.sql`, and the `crystal_chassis`
  field on `OrgProfile` (`app/src/types/index.ts`).
- **Test coverage migrated, not just deleted**: `CrystalPanel.test.tsx` (1416 lines, `executeAction`
  dispatch-branch coverage) → `CrystalPanelAUI.executeAction.test.tsx`; the still-unique subset of
  `CrystalPanelStreaming.test.tsx` (SSE event-type tolerance, REST fallback, error/402/transport-failure
  paths — the citation/viz/appliedFilters coverage was already duplicated against the real
  `CrystalThreadShell` in `CrystalThreadShell.test.tsx`, so that part wasn't re-ported) →
  `CrystalPanelAUI.streamingFailures.test.tsx`; `CrystalPanelA11y.test.tsx`'s three behaviors →
  split across `CrystalPanelAUI.test.tsx` (Escape-to-close, close-button aria-label) and
  `CrystalThreadShell.test.tsx` (send-button aria-label, since that button now lives in the shell,
  not the panel chrome); `CrystalPanelReportProposals.test.tsx` just repointed its import to
  `crystal/runtime/reportProposals.ts` directly (a pure function, unaffected by the chassis change).
- **A real gap found and fixed during this retirement, not just during the earlier build**:
  `CrystalPanelAUI` was only ever passing STARTER prompt chips to `CrystalThreadShell`'s
  suggestions bar — it never surfaced the LIVE per-turn follow-up suggestions Crystal returns with
  each answer (`message.suggestions`, populated by `useCrystalConversation.ts` from the `answer`
  event), which the legacy panel rendered inline per-bubble via `CrystalBubble`'s `onFollowUp`.
  Fixed: once a conversation has messages, the suggestions bar now shows the latest `crystal`
  message's own `.suggestions` instead of the static starter list. Real design difference,
  not hidden: it's now a single thread-level bar (assistant-ui's own idiom) rather than
  per-bubble-forever chips.
- **`MIGRATION_PLAN.md`/`MIGRATION_TEST_PLAN.md` below are now historical** — they describe the
  original calendar-gated G2→G3→G4 rollout design (≥2-week funnel baseline, 30-day retention
  window before cutover). That design was deliberately overridden by an explicit product-owner
  decision, not superseded by new information invalidating it — read them for the reasoning
  behind the funnel-outcome-recording mechanism (`crystal_action_proposals`, still very much
  alive and unaffected by this), not as the current rollout plan.

## CrystalThreadShell rebuilt on real assistant-ui primitives (2026-08-12)

Per explicit product-owner request: the G0-era `CrystalThreadShell.tsx` hand-composed bare,
unstyled primitives (plain divs, default circles) because the shadcn-style registry-copy CLI
(`npx assistant-ui add <name>`) fetches from `https://r.assistant-ui.com`, confirmed **unreachable
from every sandboxed tool in this environment** (direct `curl` → `HTTP 000`, re-verified fresh
before concluding this, not just cited from memory). That command cannot be run by anyone working
in this environment — it is a hard constraint, not a retry-and-it-might-work situation.

**What was added as real, genuine npm dependencies instead** (`app/package.json`):
`@assistant-ui/react-markdown` (exact-pinned `0.14.10`, matching the same-vendor no-caret rule
already applied to `@assistant-ui/react` — `MIGRATION_PLAN.md` §3 churn mitigation), `remark-gfm`,
`tw-animate-css`. `@assistant-ui/styles` was installed then removed — npm flags it **deprecated**.
Zero new vulnerabilities introduced (npm audit's 21 pre-existing findings are entirely in
`@novu/react`'s unrelated dependency chain). Also fixed `app/components.json`'s `"tsx": false`
(a known bug flagged during planning — would have emitted `.jsx` into a strict-TS app the moment
anyone ran the registry CLI).

**The rebuild** (`CrystalThreadShell.tsx`, verified against installed `.d.ts` files, not memory):
real `ThreadPrimitive`/`MessagePrimitive`/`ComposerPrimitive`/`ActionBarPrimitive` composition
(the actual assistant-ui shape — `Messages` dispatch via `components={{UserMessage,AssistantMessage}}`,
not a hand-rolled switch); real markdown via `MarkdownTextPrimitive` + `remarkGfm`; real animations
(`tw-animate-css` imported in `index.css` — confirmed via an actual `vite build` + compiled-CSS grep,
not assumed; side effect: 6 previously-inert `ui/` components — dropdown-menu, sheet, tooltip,
dialog, select, popover — now animate for real, having silently referenced these classes with the
package never installed); real brand identity (`var(--color-primary)`/`var(--color-tertiary)`
gradients and `color-mix()`, zero literal hex, matching `CrystalPanel.tsx`'s own vocabulary).
`CrystalThinkingBubble`/`ActionProposalCard` render byte-identical; only their container changed.

**Independently verified, not just self-reported**: `tsc` clean, `eslint` clean, 1258/1258 tests
(same count — no coverage lost, all 8 pre-existing `CrystalThreadShell.test.tsx` assertions pass
unmodified against the new DOM), `check-i18n` 0 missing keys, spot-checked the actual file content
(primitive usage, gradient/color-mix lines, zero hex, markdown import, i18n key usage) directly
rather than trusting the report.

**Still not literal parity with the live registry** — this is a faithful reconstruction on the real
underlying primitives per the actual assistant-ui architecture, not a byte-copy of whatever
`r.assistant-ui.com` currently serves (impossible to fetch here). Worth re-diffing against the live
registry once someone with real network access can run the CLI, per the original G0 plan.

## Real production bug found and fixed during live-preview work (2026-08-09)

Writing a direct test for `useCrystalConversation.ts` (mocking `fetch` with a real scripted SSE
stream, rather than feeding pre-built message arrays as G0's tests did) caught a genuine,
pre-existing bug: the `citation_context` handler assumed `prev[prev.length - 1]` was always the
prior turn's Crystal answer. It never was — `submitQuery` appends the new turn's **user** message
first, before reading any SSE event, so the array tail at `citation_context` time is always the
*current* turn's user message. **Cross-turn citation retro-enrichment — the exact feature G0's own
gate claimed to prove — was dead code, in production, today**, inherited byte-identical from
`CrystalPanel.tsx`'s original inline implementation. G0's tests looked green only because they
bypassed the real message-append order.

**Fixed**: the handler now scans backward for the last message with `role === 'crystal'` instead
of assuming array position (`useCrystalConversation.ts`, the `citation_context` branch). One pinned
test assertion (`useCrystalConversation.test.ts`) that had encoded the broken behavior as "expected"
was rewritten to assert the correct enrichment. Verified independently: `tsc` clean, 1258/1258 app
tests green, diff spot-checked directly.

**Lesson for future phases**: G0/G2 test claims about cross-turn behavior are only trustworthy when
they go through the real `submitQuery`/SSE code path, not hand-built message arrays — the
`CrystalThreadShell.test.tsx` retro-enrichment tests still splice `setMessages` manually and would
not have caught this; they test rendering only, not the real state-transition ordering.

## Out-of-scope change made at explicit product-owner request (2026-08-06)

**Not part of the migration plan** (`README.md`'s "Out of scope" explicitly excludes Crystal's
reasoning quality/prompts/skills) — done anyway because the product owner asked directly, worried
the migration's richer content would need more room. `crystalos/lib/models.py`: `crystal` (pipeline
role) and `crystal-analyst` (skill) switched from `google/gemini-2.5-flash` to
`deepseek/deepseek-v4-flash` (dev-paid) / `deepseek/deepseek-v4-pro` (staging/prod); `max_tokens`
roughly doubled (1500→3000 / 1200→2400). `dev` (free tier) left untouched — no free DeepSeek model
exists in this file's documented pools. `crystal_eval` (the hallucination-check judge) deliberately
**not** touched, preserving the file's own cross-vendor QC rule now that `crystal` is DeepSeek.

**Two things worth remembering:** (1) the stated reason (migration needs bigger responses for
charts) doesn't actually hold — `_build_viz_for_citations` is deterministic Python that runs after
the LLM call and costs zero extra tokens; the real beneficiary is citation/suggestion/proposal
richness in general. (2) **Context window went down, not up, for this role** — DeepSeek's
documented capacity in this file is 128K vs. Gemini's 1M. This is a real, deliberate tradeoff
(no larger-context DeepSeek variant is recorded anywhere in the codebase), not an oversight — a
pre-existing test asserting the old 256K floor was lowered to 128K with an explanatory comment,
not quietly patched around. Verified independently (2128 tests pass, exact routing values
spot-checked against the file directly, not just the agent's self-report).

## Open items carried forward, not resolved this pass

- Decision #6 (cosmetic/platform choices) — needs product call before G3.
- `user_role` self-assignment / permission-map vulnerability (`MIGRATION_PLAN.md` §8) — real,
  currently inert, **not fixed in this pass**. Do not "fix" the permission map without also
  fixing the body-spread in the same release (fixing one without the other activates the bug).
- `ActionProposalType` cross-language drift (TS union vs. Python free string) — flagged for
  P0-3, only fixed if trivial; otherwise still open.
- Two live bugs in every turn (`crystal.py:1659` sync-def-in-`create_task` TypeError swallowed by
  bare except; EVALS scorer defect is P0 #1 above) — **confirmed already fixed** in the working
  tree when the G1 agent checked (regression test already existed and passed); no action needed.
- `aria-live="polite"` announcement for the streaming/thinking state (`MIGRATION_PLAN.md` §9,
  ~45 LOC estimate) — evaluated during G1, deliberately not shipped: collides with ~8 pinned
  `getByText`/exact-count assertions in `CrystalPanel.test.tsx`/`CrystalPanelStreaming.test.tsx`.
  Needs someone to rewrite those assertions to scope queries (`within(...)`) first.

## Live preview (2026-08-06, later same day)

`useCrystalConversation.ts` (`app/src/components/crystal/runtime/`) — Crystal's real
`submitQuery`/SSE-handling/action-execution logic extracted from `CrystalPanel.tsx` into a shared
hook. `CrystalPanel.tsx` now calls it (verified: `grep` shows the real call site, not a parallel
duplicate) with zero behavior change (`tsc`/`eslint` clean, 1251/1251 existing tests green).
Wired for real (not mocked) into a dev-only preview: route `/dev/crystal-thread-shell`
(`app/src/pages/dev/CrystalThreadShellDevPage.tsx`), gated on `import.meta.env.DEV` so it's
unreachable in any production build. **This is a genuine live preview** — typing a message on
that route makes a real SSE/HTTP call to the real backend through the new assistant-ui shell,
using dev-mode auth (no `CLERK_SECRET_KEY`/`VITE_CLERK_PUBLISHABLE_KEY` needed locally).

To see it: `docker-compose up -d && cd backend && npm start` (separate terminal) `&& cd crystalos && make run-dev`
(separate terminal) `&& cd app && npm run dev`, then open `http://localhost:5173/dev/crystal-thread-shell`.
Requires real `OPENROUTER_API_KEY`/`DATABASE_URL` in your own `.env` files — this sandbox has
neither Docker running nor read access to `.env`, so this was verified by static/lint/test
inspection here, not by actually opening a browser. Direct test coverage of the hook's real
fetch/SSE-parsing code (as opposed to CrystalPanel's pre-existing regression tests, which only
prove behavior didn't change) is in progress separately.

## Session summary (2026-08-06) — P0, G0, G1 complete

All work is additive and/or flag-gated per the plan's incremental constraint — **nothing new is
wired into `CrystalPanel.tsx`'s production render path** except the always-on a11y fixes (explicitly
approved to ship unflagged per `MIGRATION_PLAN.md` §5). `lib/flags/crystalChassis.ts` returns `false`
unconditionally; the new assistant-ui shell (`CrystalThreadShell.tsx`) exists, is tested, and renders
nothing in production yet.

**The tool-widget extension point** (the "add a widget later" ask): `app/src/components/crystal/genui/`
— `types.ts` (contract, now a discriminated union on `kind` rather than one flat interface — see below),
`registry.ts` (`CRYSTAL_VIZ_REGISTRY`, typed as a mapped type `{ [K in VizKind]: ComponentType<Extract<VizSpec, {kind:K}>> }`
so each entry is checked against its own branch, not the full union). CrystalOS emits the matching `VizSpec`
deterministically (`crystalos/agents/crystal.py`, `_build_viz_for_citations` — Tier-0, never model-chosen).

**Second widget shipped: `sentiment_by_segment_chart`** (`SentimentBySegmentChart.tsx`, same
degenerate-data/a11y/brand-var pattern as `NpsBarChart.tsx`). Fires for CSAT/CES/topic-driven
turns (`metric.csat`/`metric.ces`/`voice.topic` insight categories), not just NPS — uses
`avg_sentiment_score`, the one per-segment field `get_segment_breakdown` always populates,
unlike `nps_avg` which requires NPS-scored responses. `_build_viz_for_citations` tries
`nps_bar_chart` first (more specific) and falls back to this one when an NPS insight is cited
but no segment carries `nps_avg` — so a CSAT-only survey still gets a chart instead of none.
Confirmed this is genuinely the second, not first, real use of the extension point — `VizKind`
widening from a single-member literal to a 2-member union required narrowing each component's
own prop type via `Extract<VizSpec, {kind:'...'}>` (was implicitly typed to the old single-shape
`VizSpec` before) and one documented cast at the one dynamic-dispatch call site
(`CrystalThreadShell.tsx`'s `CrystalVizNode`) where a `Record` lookup can't preserve
discriminated-union narrowing — both are now the template for the *third* widget, not new
ground to break again.

**Adding a third widget = one `VizKind` union member + matching data-shape interface (`types.ts`)
+ one `CRYSTAL_VIZ_REGISTRY` entry + one component (typed to its own `Extract<VizSpec,...>` branch)
+ (if server-driven) one more branch in `_build_viz_for_citations` or a new deterministic builder
function + a matching `Literal[...]` member on the Python `VizSpec.kind`** — no other files change.

**Still queued, correctly not implemented:** G2 (full parity, blocked on `XperiqCopilot` full
convergence — step 1 only ported a11y up, retiring/merging the two implementations is separate),
G3 (markdown / thread persistence / chart expansion / decision #6's cosmetic items), G4 (cutover).
These sit behind the plan's two hard calendar waits (≥2-week live funnel baseline, 30-day fallback
retention) — no amount of further agent work shortens them; they need calendar time after G1/G2 ship
to production, plus a product decision on G3 ordering.
