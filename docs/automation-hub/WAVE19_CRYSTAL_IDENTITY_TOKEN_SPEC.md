# Wave 19 — Crystal Visual Identity Token Spec

**Author:** Rohan Desai (Principal Product Designer, Builder Experiences)
**Status:** Spec complete — ready for Elias to build from
**Scope:** App-wide (not Automation-Hub-scoped), per user's explicit Wave 19 decisions in `docs/automation-hub/TRACKER.md`
**Constraints given:** (1) "use org setting and use it everywhere," (2) "be very very careful and accurate"

This spec is grounded in the actual current code (`app/src/styles/theme.css`, `app/src/index.css`, `app/src/lib/brandTheme.ts`), not just the prose description in root `CLAUDE.md` — and it corrects two assumptions implicit in the Wave 19 kickoff brief that do not hold once you read the code. Both corrections are load-bearing for Elias, so they're called out immediately.

---

## 0. Two corrections to the brief, verified against code

### 0.1 The gradient pair is not coincidental — it's literally the brand default

`app/src/lib/brandTheme.ts`'s `DEFAULT_BRAND_THEME` and `app/src/styles/theme.css`'s `:root` block both hardcode:

```
--brand-primary: #2a4bd9   (DEFAULT_BRAND_THEME.primary)
--brand-accent:  #8329c8   (DEFAULT_BRAND_THEME.accent)
```

These are byte-identical to Crystal's hardcoded gradient stops (`#2a4bd9` → `#8329c8`) found everywhere in the app. This is confirmed **intentional, not coincidental** by `docs/branding/BRAND_GUIDE.md` §5 (Colors), which names these exact hexes "Xperiq Blue" and "Crystal Purple" and states the rule explicitly: **"Crystal Purple is for AI. Any feature powered by Crystal gets purple treatment."** Crystal's identity was designed as literally the company's own default primary/accent brand pair — there is no separate "Crystal sub-brand" hex distinct from the org brand defaults. See §2 for why this still doesn't make the org-brand-following decision automatic.

### 0.2 `--color-accent` is NOT the semantic alias for `--brand-accent` — use `--color-tertiary`

This is the single most important correction in this spec, because getting it wrong ships a silent bug.

Reading `app/src/styles/theme.css` and `app/src/index.css` directly (not just root `CLAUDE.md`'s prose table, which elides this):

| Brand token | Semantic alias | Where defined |
|---|---|---|
| `--brand-primary` (#2a4bd9) | `--color-primary` | `theme.css` `:root`, `var(--brand-primary)` |
| `--brand-secondary` (#00647c) | `--color-secondary` | `theme.css` `:root`, `var(--brand-secondary)` |
| `--brand-accent` (#8329c8) | **`--color-tertiary`** | `theme.css` `:root`, `var(--brand-accent)` |

`--color-accent` is a **completely different, unrelated token** — it's a shadcn-bridge neutral gray (`#dfe3e6` / `#2c2f31` foreground), defined in the Tailwind `@theme` block in `index.css` (lines 132–133), used for shadcn's `accent`/`accent-foreground` slots (e.g. dropdown-menu hover backgrounds). It has zero connection to the brand purple and does **not** respond to `applyBrandTheme()`.

**Proof this is a real, exploitable trap, not theoretical:** `app/src/lib/workflowScopeDisplay.ts:9` already has this exact bug today:

```ts
export function scopeRailColorVar(scopeType: WorkflowScopeType | undefined): string {
  if (scopeType === 'survey') return 'var(--color-primary)';
  if (scopeType === 'tag') return 'var(--color-accent)';   // ← BUG: resolves to shadcn gray #dfe3e6, not brand purple
  return 'var(--color-outline)';
}
```

The file's own header comment claims "Colors are brand-reactive CSS var names... never hardcoded hex, so a brand-theme override still applies" — the intent was clearly to make "tag" scope render in the brand purple (parallel to "survey" scope using `--color-primary`), but it silently resolves to a static gray instead, and **never** reflects an org's custom accent color. This is the same defect class Wave 19 exists to fix, found incidentally during this audit. **Elias: fix this alongside the Crystal work** (`var(--color-accent)` → `var(--color-tertiary)` at that line) — it's one line, same root cause, same PR makes sense.

**Rule for this spec and all future work:** the correct semantic alias for Crystal Purple / `--brand-accent` is always **`--color-tertiary`**. `--color-accent` must never be used for brand/Crystal purple.

### 0.3 Confirmed existing convention: use the semantic alias, not the raw `--brand-*` var, in component code

Grepping actual usage confirms the convention root `CLAUDE.md` states generically is followed in practice: `CrystalPanel.tsx`, `workflowScopeDisplay.ts`, and other consuming files use `var(--color-primary)` / `var(--color-tertiary)`, not `var(--brand-primary)` / `var(--brand-accent)` directly. The only files that touch `--brand-*` directly are the definition/management layer itself (`theme.css`, `brandTheme.ts`, `BrandSettingsPage.tsx`'s live gradient preview swatch). **This spec follows that convention**: all replacements below use `--color-primary` / `--color-tertiary` / `--color-secondary`, never `--brand-*` directly.

---

## 1. The core design decision: should Crystal always be purple-blue, or follow org brand?

**Decision: Crystal follows the org's brand setting (`--color-primary` → `--color-tertiary`). It does NOT stay fixed purple-blue regardless of org theme.**

This is a real decision with a real alternative (the "Slack purple" model — keep Crystal recognizable as a distinct AI surface across every org, the way Slack's aubergine stays constant regardless of a workspace's custom theme). Here is why that model is wrong for this product, specifically, based on what actually exists in this codebase and docs — not by default or by not thinking about it:

1. **The user's instruction is explicit and unambiguous**: "use org setting and use it everywhere." A Slack-style fixed sub-brand is the one interpretation that directly contradicts this instruction. Overriding an explicit instruction requires a strong countervailing reason; none exists here (see below).
2. **There is no product doc anywhere carving out Crystal as brand-protected.** I searched `docs/branding/` (BRAND_GUIDE.md, BRAND_STRATEGY.md, BRAND_GOVERNANCE.md) and `docs/crystal-research/` for any white-labeling exception, sub-brand-lock, or "Crystal stays constant" policy. None exists. `BRAND_GUIDE.md` §3 treats Crystal as a **naming/voice** sub-brand ("Crystal by Xperiq," tone, "copilot not chatbot"), not a **color-lock** sub-brand — its color section (§5) gives Crystal Purple a *use* ("Crystal AI elements... get purple treatment") inside Xperiq's own default palette, it never says that use must survive a customer overriding the org's accent color.
3. **The accent color is a genuine, real, already-shipped per-org customization control**, not a hypothetical: `BrandSettingsPage.tsx` lets an org admin set `accentColor` (defaulting to `DEFAULT_BRAND_THEME.accent`), which is persisted server-side in `org_profiles.brand_colors` (JSONB, `backend/src/routes/orgProfile.ts`) and re-applied via `applyBrandTheme()` on every load. This is a real, live, named "accent" setting whose entire *purpose* — per the actual product surface, not a guess — is "the org's chosen tertiary/AI-adjacent brand color." If an org sets a custom accent and Crystal ignores it, the org's own brand settings page becomes partially non-functional (looks like it works, silently doesn't apply everywhere) — that is a worse, more confusing outcome for a white-label enterprise customer than "Crystal isn't purple anymore."
4. **The Slack-purple analogy doesn't transfer.** Slack is a single company selling one product with one identity to everyone; brand consistency across workspaces is a deliberate choice to keep "Slack" recognizable as a vendor, and Slack does **not** offer workspace admins an "accent color" setting that's supposed to reskin its AI feature. Xperiq is different: it explicitly sells white-labeling (`brandName`, `logoUrl`, `brand_colors` all customer-configurable, per `BrandSettingsPage.tsx` and `BrandProvider`) to enterprise customers who want the *whole product*, including AI-forward chrome, to read as their own. An enterprise buyer who reskins Xperiq red should reasonably expect their whole product — including its AI copilot — to read as "their" red-and-X product, not have one prominent, frequently-seen surface stay a competitor-neutral purple that visibly doesn't match everything else they just customized. That mismatch would look like a bug to the customer, not a feature.
5. **A fixed-purple Crystal was never how the codebase already treats brand-vs-Crystal color.** Multiple already-in-production files (`ConnectorModal.tsx`, `ContactDetailPage.tsx`, `ContactsPage.tsx`, `CasesPage.tsx`, `SettingsConnectionsPage.tsx`) already do a **half-migration**: `linear-gradient(135deg, var(--color-primary), #8329c8)` — primary stop tokenized, accent stop still hardcoded. Nobody treated the purple stop as sacred; it was simply missed, not deliberately preserved. That's further evidence the fixed-purple-identity idea isn't an existing design intent being violated — it's a consistency bug being completed.

**Conclusion: the fix is mechanically simple exactly as the brief hoped, once corrected for §0.2.** Replace every Crystal-identity hardcoded `#2a4bd9` → `var(--color-primary)` and every `#8329c8` → `var(--color-tertiary)`. No sub-brand-lock layer, no separate "Crystal token namespace," no product exception. One cascade, one source of truth, exactly matching "use org setting and use it everywhere."

### 1.1 The extended palette (container/tint shades)

The fuller "Crystal look" palette used in the CSS-only orb and a few gradients also maps 1:1 to existing container tokens — no new tokens needed:

| Hardcoded hex | Semantic alias | Brand token |
|---|---|---|
| `#2a4bd9` | `var(--color-primary)` | `--brand-primary` |
| `#173dcd` | `var(--color-primary-dim)` | `--brand-primary-dim` |
| `#879aff` | `var(--color-primary-container)` | `--brand-primary-container` |
| `#8329c8` | `var(--color-tertiary)` | `--brand-accent` |
| `#d299ff` | `var(--color-tertiary-container)` | `--brand-accent-container` |
| `#00647c` | `var(--color-secondary)` | `--brand-secondary` |
| `#82deff` | `var(--color-secondary-container)` | `--brand-secondary-container` |

`rgba(42,75,217, X)` (the tinted/opacity variants used everywhere for hover backgrounds, borders, glows) should become `color-mix(in srgb, var(--color-primary) X%, transparent)` — this pattern already exists in `theme.css` (`--shadow-primary`, `--shadow-card-hover`) so it's an established idiom, not a new one. Same for `rgba(131,41,200, X)` → `color-mix(in srgb, var(--color-tertiary) X%, transparent)`.

---

## 2. Font handling

**Finding: no gap.** Crystal-branded components (`CrystalPanel.tsx`, `AskCrystalFab.tsx`, `NLThinkingCrystal.tsx`, `CrystalNarrativeWidget.tsx`) contain **zero** hardcoded `font-family` declarations. Verified by direct grep of each file — none matched `font-family|fontFamily|Manrope|Inter`.

This is because typography is applied globally, not per-component: `index.css` sets `body { font-family: var(--font-body); }` (line 150), and `--font-body`/`--font-headline` alias to `--brand-font-body`/`--brand-font-heading` in `theme.css`. Crystal's text inherits this cascade automatically — it already responds correctly to `applyBrandTheme({ fontHeading, fontBody })` today. **No font fix needed for Crystal components.** No action item here.

### 2.1 One real font gap found, but it's NOT a Crystal component — flag only, no fix required by this wave

`app/src/components/Logo.tsx` (`LogoFull`) hardcodes `fontFamily: 'Manrope, sans-serif'` (wordmark) and `fontFamily: 'Inter, sans-serif'` (tagline) rather than `var(--brand-font-heading)`/`var(--brand-font-body)`. This is the **Xperiq company wordmark**, not Crystal — see §4.3 for why this is explicitly out of scope for Wave 19 and should not be silently swept in.

---

## 3. Full inventory

68 files contain the hardcoded hex values (`#2a4bd9`, `#8329c8`, and their container/dim shades), well above the tracker's "20+ files" estimate. They fall into three categories. Elias should tokenize (a) and (b); (c) must be left alone.

### (a) CRYSTAL-IDENTITY — tokenize to `--color-primary` / `--color-tertiary`, Wave 19a (do first)

These are the actual Crystal AI surfaces: the global Crystal panel, the workflow builder's Crystal FAB, AI-generation CTAs, and the CSS-only Crystal orb.

| File | Representative lines | Element | Fix |
|---|---|---|---|
| `app/src/components/CrystalPanel.tsx` | ~35 hits: 1089, 1107, 1109, 1117, 1119, 1125, 1136, 1191, 1193, 1394, 1399–1400, 1441, 1535, 1543, 1554, 1564, 1581, 1693–1694, 1710, 1854, 1932, 1938, 1969–1970, 1981, 2023, 2128–2139, 2277, 2286, 2291, 2302, 2309, 2313–2314, 2319, 2346, 2362–2363, 2421, 2454, 2459–2460, 2546, 2589, 2597, 2664 | Panel header gradient, avatar orb, thinking-state conic-gradient crystal, tool-call badges, citation icons, proposal priority colors, progress bar | Hex → `var(--color-primary)` / `var(--color-tertiary)`; `rgba(42,75,217,X)` → `color-mix(in srgb, var(--color-primary) X%, transparent)`; `rgba(131,41,200,X)` → same with `--color-tertiary`. **Note**: lines 1229, 1693, 1750, 1969, 1981 already correctly use bare `var(--color-primary)` — this file is in a partially-migrated state today, so the diff here is smaller than 35 lines of net-new work; several are already-right and just need the remaining literal-hex neighbors fixed to match. Lines 2319/2346 use `var(--color-primary, #2a4bd9)` (var-with-hardcoded-fallback) — drop the fallback once confident, or leave the fallback as defensive default (harmless, matches token default exactly, see §4.2). |
| `app/src/components/workflow-builder/AskCrystalFab.tsx` | 64, 68, 83–84 | Floating "Ask Crystal" button gradient + shadow | Same mapping |
| `app/src/components/three/NLThinkingCrystal.tsx` | 23–25 | Three.js point-light colors on the 3D thinking crystal | `color="#8329c8"` → needs JS-resolved value, not CSS var (Three.js material props aren't CSS) — see §4.4 for the technical handling |
| `app/src/components/dashboard/widgets/CrystalNarrativeWidget.tsx` | 44 | Crystal narrative card shadow | `rgba(42,75,217,0.35)` → `color-mix(...)` |
| `app/src/pages/experience/ExperienceHubPage.tsx` | 455, 513–514, 522, 592–605 (CSS Crystal orb, per `app/CLAUDE.md`'s documented example) | "Generate Insights" CTA gradient, empty-state icon, the CSS-only Crystal orb (conic-gradients + radial-gradient core) | Same mapping across all 3-stop conic-gradients |
| `app/src/pages/experience/SurveyIntelligencePage.tsx` | 315, 457, 494, 749–752 | "Generate insights" CTA, live-generation pulse dot, hero orb gradient | Same mapping |
| `app/src/pages/insights/GeneratingOverlay.tsx` | 51, 100 | "Generating insights..." overlay (Crystal actively working) — active vs. idle state styling | Same mapping |
| `app/src/components/SupportCommandPalette.tsx` | 298 | "Ask Crystal support" category badge in the command palette | Same mapping |

**Checked and confirmed clean:** `app/src/components/AdminCrystalNav.tsx` — contains no hardcoded Crystal-identity hex today (verified by direct grep); no action needed.

**Dead code, exclude from active build but flag for cleanup decision:**

| File | Finding |
|---|---|
| `app/src/components/IrisChat.tsx` | Full duplicate Crystal-gradient chat UI under an unused/legacy name "Iris." **Zero imports anywhere in the codebase** (confirmed via `grep -rl` for `IrisChat` outside its own definition file — no consumer, no test references it either). |
| `app/src/components/AiChatPanel.tsx` | Same pattern — generic "AI" chat panel, Crystal gradient, **zero imports anywhere**. |

Recommendation: do not spend Wave 19 effort tokenizing these two — they render nowhere. Flag to Maya/Priya as delete-candidates in a separate cleanup pass; tokenizing dead code adds test/maintenance surface for zero user-visible benefit. If kept "for later," add a `// UNUSED — see WAVE19 spec` comment; don't silently leave ambiguous.

### (b) GENERIC-BRAND-REUSE — tokenize to `--color-primary` / `--color-tertiary`, Wave 19b (do second, long tail)

Generic UI chrome that happens to use the same brand blue/purple pair but has no specific tie to "Crystal" as a feature — decorative hero gradients, generic AI-adjacent buttons/spinners, chart series colors, status/priority pill colors that reuse brand hues for non-taxonomic reasons. Tokenizing these is still correct and desirable (same "use org setting everywhere" mandate, same brand-consistency goal) — they are just lower priority and lower risk to defer, since they aren't the surface the user specifically called out as "Crystal."

Representative files (not exhaustive — pattern is consistent, Elias should grep-and-fix systematically rather than treat this as a fixed list):
`components/AiChatPanel.tsx`*, `components/IrisChat.tsx`* (*dead, see above — skip),
`components/AppShell.tsx`, `components/ErrorBoundary.tsx`, `components/integrations/ConnectorModal.tsx`, `components/LoadingStates.tsx` (`Spinner` default color), `components/Logo.tsx` (color stops only — NOT the font-family, see §4.3), `components/NovuInboxProvider.tsx` (needs JS resolution, see §4.4), `components/SurveyActionModal.tsx`, `components/SurveyTypeGallery.tsx`, `components/UpgradeModal.tsx` (plan-tier colors — verify against §c, borderline), `components/three/HeroCanvas.tsx`,
`pages/AdvancedInsightsPage.tsx`, `pages/BillingPage.tsx`, `pages/BroadcastApprovalPage.tsx`, `pages/BroadcastsPage.tsx`, `pages/CaseDetailPage.tsx`, `pages/CasesPage.tsx`, `pages/ContactDetailPage.tsx`, `pages/ContactSegmentsPage.tsx`, `pages/ContactsPage.tsx`, `pages/DataPage.tsx`, `pages/ErrorPage.tsx`, `pages/LandingPage.tsx`, `pages/NotificationAnalyticsPage.tsx`, `pages/OnboardingPage.tsx`, `pages/OwnershipRoutingPage.tsx`, `pages/ResponseCollectionPage.tsx`, `pages/ResponseDashboardPage.tsx`, `pages/SampleResponsesPage.tsx`, `pages/SettingsConnectionsPage.tsx`, `pages/SurveyBuilderPage.tsx`, `pages/SurveyCreationPage.tsx`, `pages/SurveyFillPage.tsx`, `pages/SurveysListPage.tsx`, `pages/TemplateEditorPage.tsx`, `pages/TemplateLibraryPage.tsx`, `pages/WorkflowCanvasPage.tsx`, `pages/WorkflowNLBuilderPage.tsx`, `pages/WorkflowsPage.tsx`,
`pages/insights/CockpitView.tsx`, `pages/insights/components/ImpactScatterChart.tsx`, `pages/insights/components/TopicCard.tsx`, `pages/insights/components/TopicDetailPanel.tsx` (chart series colors — Recharts `stroke`/`stopColor` props, same JS-resolution caveat as §4.4), `pages/insights/components/TopicHierarchyTree.tsx`, `pages/insights/ConversationView.tsx`, `pages/insights/EditorialView.tsx`, `pages/insights/InsightsBriefPage.tsx`, `pages/insights/InsightsFindingsPage.tsx`, `pages/insights/InsightsMetricsPage.tsx`, `pages/insights/InsightsSurfacedPage.tsx`, `pages/insights/SpatialView.tsx`, `pages/insights/TopicsAnalysisPage.tsx`, `pages/insights/UnifiedInsightsView.tsx`, `pages/InsightsDashboardPage.tsx`,
`pages/experience/SurveyReportPage.tsx`, `pages/experience/SurveyTrendsPage.tsx`, `pages/experience/TopicAnalysisHubPage.tsx`, `pages/experience/TopicDeepDivePage.tsx`, `pages/GroupReportPage.tsx`, `pages/prism/PrismHomePage.tsx`.

Also: `app/src/lib/workflowScopeDisplay.ts:9` — not a hardcoded hex, but the `--color-accent` misuse bug from §0.2. Fix in the same pass since it's the identical root cause.

### (c) INCIDENTAL/UNRELATED — do NOT tokenize; leave hardcoded

These use the same hex values by coincidence of an enum/categorical color-mapping, where "brand color" was never the intent — tokenizing them would make an unrelated color-coding scheme silently shift whenever an org changes its brand color, which is undesirable (these need a **stable, distinguishable palette independent of brand**, not brand tracking).

| Pattern | Files | Why it's excluded |
|---|---|---|
| **Insight layer taxonomy** (`descriptive`/`diagnostic`/`predictive`/`prescriptive` — 4-way categorical color code, documented in `app/CLAUDE.md`'s "Insight Layer System" as `LAYER_CONFIG`) | `components/CrystalPanel.tsx:1668-1673` (`LAYER_COLORS`), `pages/insights/shared.tsx:20-21` (`LAYER_CONFIG`), `pages/experience/ExperienceHubPage.tsx:37-41` (`LAYER_BORDER`), `pages/GroupReportPage.tsx:23`, and their matching `__tests__/pages/ExperienceHubPage.test.tsx` / `SurveyIntelligencePage.test.tsx` assertions | These are a fixed 4-color legend (blue/purple/amber/green) users learn to recognize as "which layer of insight is this" across every survey and every org — changing "descriptive" from blue to an org's red primary would break the legend's own internal logic (4 distinct categories no longer look distinct, and no longer match any other org's screenshots/support docs/training material referencing "blue = descriptive"). This is a data-visualization categorical palette, not brand chrome. |
| **Question-type / survey-type color coding** | `constants/questionTypes.ts`, `constants/surveyTypes.ts` | Same reasoning — arbitrary per-type distinguishing colors across many question/survey types (not just 2), used purely so the builder UI can visually distinguish types at a glance. Not brand-linked in intent. |
| **Plan/tier badges** | `components/UpgradeModal.tsx` (`starter`/`business`/`enterprise` colors) | Pricing-tier color coding is a marketing/sales taxonomy independent of the viewing org's own brand — an enterprise customer's dashboard shouldn't make the "Business" plan badge render in their own brand color, that would be confusing (is this MY plan-colored badge, or a generic label?). |
| **Case/contact priority enums** | `pages/CaseDetailPage.tsx`, `pages/CasesPage.tsx` (`medium`/`high`/`low` priority colors), `pages/BroadcastApprovalPage.tsx`/`BroadcastsPage.tsx` (status enums like `submitted`/`sent`/`sending`) | Same reasoning as insight layers — fixed status/priority vocabularies used for fast visual scanning across rows; changing them per-org brand would defeat their scanning purpose and drift from any status color legend documented elsewhere. |
| **`theme.css` / `index.css` token *definitions*** | `styles/theme.css:21,32` (`--brand-primary`, `--brand-accent`), `index.css:41,62,76,135` (`@theme` block, `--color-surface-tint`, `--color-ring`), `lib/brandTheme.ts:30,37` (`DEFAULT_BRAND_THEME`) | These aren't "usages" — they're the token defaults themselves, i.e., the thing everything else should point to. Never touch these values as part of "removing hardcoded Crystal color" work; they're correct by definition and must keep matching the current defaults for the zero-visual-diff guarantee in §4.2 to hold. |

**One ambiguous case flagged for a product call, not a design call:** `components/UpgradeModal.tsx`'s `business: '#8329c8'` sits right on the boundary — it's a tier-enum color (→ category c) but also visibly "the purple," which some users might read as "premium/AI-tier." Recommendation: leave as-is (category c) unless Maya specifically wants pricing-tier color to track brand, which would be an unusual product choice worth a deliberate call, not a default.

---

## 4. Migration safety plan

### 4.1 Stage the rollout — three waves, not one PR

Given "be very very careful," do NOT ship this as a single sweeping find-replace PR. Stage as:

- **Wave 19a — Crystal-identity core** (§3a): `CrystalPanel.tsx`, `AskCrystalFab.tsx`, `NLThinkingCrystal.tsx`, `CrystalNarrativeWidget.tsx`, the CSS Crystal orb in `ExperienceHubPage.tsx`/`SurveyIntelligencePage.tsx`, `GeneratingOverlay.tsx`, `SupportCommandPalette.tsx`. This is the surface the user actually complained about (Crystal's own visual identity) and the highest-traffic, most frequently seen Crystal UI. Ship and verify this first, in isolation, before touching anything else — if something regresses visually, the blast radius is contained to Crystal's own chrome, not the whole app.
- **Wave 19b — generic brand-reuse long tail** (§3b, ~50 files): once 19a is verified clean, sweep the remaining files mechanically. Because the fix pattern is identical everywhere (`#2a4bd9`→`var(--color-primary)`, `#8329c8`→`var(--color-tertiary)`, `rgba(...)`→`color-mix(...)`), this can be done in a handful of batched PRs grouped by directory (`pages/insights/*`, `pages/experience/*`, `components/*`, `pages/*` top-level) rather than one file at a time, but each batch should get its own PR + visual smoke-check, not one 50-file mega-diff.
- **Wave 19c — the `--color-accent` bug fix** (`workflowScopeDisplay.ts`): small, isolated, one line — bundle with 19a or ship standalone; either is fine, it's independent of the other two waves.

Explicitly **excluded from Wave 19** (do not touch): category (c) INCIDENTAL/UNRELATED files, and `Logo.tsx`'s font-family hardcoding (§4.3). Dead code (`IrisChat.tsx`, `AiChatPanel.tsx`) — no action required either way; flag to Maya as a separate cleanup/deletion decision outside this wave.

### 4.2 Visual regression risk: default-branded orgs must see ZERO visual change

This is a testable, falsifiable claim, and it holds — verified directly against the code, not assumed:

- `DEFAULT_BRAND_THEME.primary = '#2a4bd9'` and `DEFAULT_BRAND_THEME.accent = '#8329c8'` in `brandTheme.ts` — byte-identical to the hardcoded hexes being replaced.
- `--brand-primary: #2a4bd9` and `--brand-accent: #8329c8` in `theme.css`'s `:root` — byte-identical.
- `--color-primary: #2a4bd9` and `--color-tertiary: #8329c8` in `index.css`'s `@theme` block (the Tailwind build-time copy) — also byte-identical.

All three layers agree on the same two hex values today. Since the vast majority of orgs (anyone who hasn't opened Brand Settings and changed their primary/accent color) run on these exact defaults, replacing a hardcoded hex with `var(--color-primary)` produces **the identical rendered RGB value** for every one of those orgs — zero visual diff, by construction, not by luck. The only orgs who will see ANY visual change are those who have explicitly saved a custom `primaryColor`/`accentColor` via `BrandSettingsPage` — which is precisely the intended, desired effect of this wave (their custom brand now actually reaches Crystal, which it doesn't today).

**Gate**: before merging Wave 19a, a human (Kenji) should screenshot-diff Crystal's panel/FAB/orb before and after on a default-brand org and confirm pixel-identical output. This is cheap and directly proves the zero-diff claim rather than asserting it.

### 4.3 Files flagged as "looks related but isn't" — do not fold into this wave

- **`components/Logo.tsx`** — the Xperiq company wordmark/logo mark. Its color gradient (§3b, category GENERIC-BRAND-REUSE) is fine to tokenize like everything else in Wave 19b. But its **hardcoded `fontFamily: 'Manrope, sans-serif'` / `'Inter, sans-serif'`** (§2.1) is a different kind of decision and should NOT be silently fixed as a drive-by in this wave: a company's own logotype font is conventionally treated as fixed brand identity (like a wordmark's letterforms), not something that reflows when an org picks "DM Sans" for their own UI. Making the "Xperiq" wordmark itself render in a customer's chosen font is a real product/brand question (does white-labeling ever extend to literally re-typesetting our own company name?) that Rohan/Maya should decide deliberately, not as a side effect of a Crystal color-consistency pass. **Recommendation: leave `Logo.tsx`'s font hardcoded, flag to Maya as a separate, explicit decision if it ever needs revisiting.**
- **`components/UpgradeModal.tsx`** — plan-tier badge colors are category (c), see §3c.
- **Insight layer / question-type / survey-type / priority enum files** — category (c), explicitly excluded, see §3c table. Elias should NOT "helpfully" tokenize these even though they contain the same hex strings — that would be the exact mistake this spec exists to prevent (conflating "same hex" with "same semantic meaning").

### 4.4 One real technical wrinkle: CSS vars don't reach JS-prop color values directly

Three files pass a color into a **JS API**, not a CSS rule, so `var(--color-primary)` as a literal string won't resolve the way it does in `style={{ background: 'var(--color-primary)' }}`:

- `components/three/NLThinkingCrystal.tsx:23-25` — `<pointLight color="#8329c8" />` (react-three-fiber prop, expects a resolved color, not a CSS var string — Three.js materials don't parse CSS custom properties).
- `components/NovuInboxProvider.tsx:32` — `colorPrimary: '#2a4bd9'` inside Novu's `appearance.variables` config object (third-party SDK theming, plain JS object, not CSS).
- Chart series colors in `pages/insights/components/TopicDetailPanel.tsx` and similar Recharts `stroke`/`stopColor` props — same category, JSX prop not CSS rule (though these are category (b), lower priority).

**Fix pattern for all three**: resolve the CSS var to a concrete value at render/mount time via `getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim()`, memoized/re-read on brand changes (e.g. in a `useEffect` keyed off whatever signal `BrandProvider` exposes for "brand changed," or simply re-read on mount since these are not per-keystroke-critical paths). Do not skip these three just because they're harder than a CSS string replace — they are still part of "everywhere" per the user's instruction, and `NLThinkingCrystal.tsx` in particular is core Crystal identity (Wave 19a), not deferrable to the long tail.

---

## 5. Test coverage plan (for Elias/Kenji)

1. **Static assertion — no literal hex in Crystal-identity files.** Add a lint-style test (or extend an existing one) that greps `CrystalPanel.tsx`, `AskCrystalFab.tsx`, `NLThinkingCrystal.tsx`, `CrystalNarrativeWidget.tsx` for `#2a4bd9`/`#8329c8` (and their rgba equivalents) and fails if found post-Wave-19a — this is the cheapest possible regression guard against someone reintroducing a hardcoded hex in a future PR to these specific files. Scope it narrowly to the Crystal-identity file list, not the whole repo (category (c) files are supposed to keep these hexes).
2. **Rendered-style assertion.** For at least `CrystalPanel.tsx`'s header/avatar gradient and `AskCrystalFab.tsx`'s button, add/update a React Testing Library test asserting the computed inline style contains `var(--color-primary)` / `var(--color-tertiary)` substrings (string-level assertion on the `style` prop/attribute is sufficient — jsdom won't resolve custom properties to computed colors, so don't attempt a `getComputedStyle` pixel assertion in unit tests).
3. **Visual-regression / zero-diff proof for default-brand orgs.** Per §4.2: a manual or automated screenshot diff of Crystal's panel + FAB + orb, default brand vs. post-Wave-19a, confirming pixel-identical rendering. If the team has any existing visual-regression tooling, wire this in; if not, a manual Kenji screenshot-compare against a known-good pre-change screenshot is the minimum bar — do not skip this given "be very very careful."
4. **Brand-override integration proof (the actual point of this wave).** A test or manual QA pass that calls `applyBrandTheme({ primary: '<custom>', accent: '<custom>' })` (or goes through `BrandSettingsPage` end-to-end) and confirms Crystal's panel/FAB/orb now render in the custom colors — i.e., prove the org setting actually reaches Crystal now, not just that nothing broke. This is the regression test that would have caught the original bug this whole wave exists to fix.
5. **`workflowScopeDisplay.ts` fix verification.** Existing/new unit test on `scopeRailColorVar('tag')` asserting it returns `'var(--color-tertiary)'`, not `'var(--color-accent)'`.
6. **Novu / Three.js JS-resolved color regression.** For `NLThinkingCrystal.tsx` and `NovuInboxProvider.tsx` (§4.4), a test confirming the resolved color changes when `--color-primary`/`--color-accent`-equivalent custom properties are overridden on `:root` before the component mounts (i.e., prove the `getComputedStyle` read actually happens and isn't stale/cached from first mount).
7. **Full regression gate**, per the tracker's Kenji mandate: confirm zero remaining hardcoded Crystal-identity hex instances (re-run the Wave 19a file-list grep expecting empty), and confirm the existing full test suite passes unmodified (any test asserting a Crystal component's *rendered pixel color* by literal hex string, if any exist beyond what's flagged in §3c, will need updating to assert the CSS var reference instead — none were found in this audit, but Kenji should re-verify at implementation time since new tests may be added between spec and build).

---

## Summary for Elias

1. **Universal replacement key**: `#2a4bd9` → `var(--color-primary)`; `#8329c8` → `var(--color-tertiary)` (never `--color-accent`); `#173dcd` → `var(--color-primary-dim)`; `#879aff` → `var(--color-primary-container)`; `#d299ff` → `var(--color-tertiary-container)`; `#00647c` → `var(--color-secondary)`; `#82deff` → `var(--color-secondary-container)`; `rgba(42,75,217,X)` → `color-mix(in srgb, var(--color-primary) X%, transparent)`; `rgba(131,41,200,X)` → `color-mix(in srgb, var(--color-tertiary) X%, transparent)`.
2. **Build order**: 19a (Crystal-identity core, §3a) → verify zero-diff (§4.2) → 19b (generic brand-reuse long tail, §3b, batched by directory) → 19c (`workflowScopeDisplay.ts` one-line fix, §0.2, can run anytime).
3. **Do not touch**: category (c) files (§3c) — insight-layer taxonomy, question/survey-type enums, plan-tier badges, priority/status enums, and the raw token-definition lines in `theme.css`/`index.css`/`brandTheme.ts`.
4. **Do not silently fix**: `Logo.tsx`'s hardcoded font-family (§4.3) — flag to Maya, don't bundle into this wave.
5. **Special handling required, not a plain string-replace**: `NLThinkingCrystal.tsx` (Three.js prop), `NovuInboxProvider.tsx` (third-party SDK config object) — both need `getComputedStyle`-based JS resolution (§4.4).
6. **Dead code, no action**: `IrisChat.tsx`, `AiChatPanel.tsx` — zero importers, flag to Maya as a deletion candidate outside this wave.
