# Assessment — Platform Integration: Design System, Accessibility, i18n

> **Author:** Theo Bergmann, Senior Software Engineer (Design Systems & Platform UI), CPACC
> **Layer:** frontend / design systems
> **Mandate:** `TEAM.md` §2
> **Date:** 2026-08-04
> **Status:** Analysis only. No production code written or edited.
> **Evidence base:** `CURRENT_STATE.md`, `ASSISTANT_UI.md`, `ASSESSMENT_CRYSTAL_UI.md`, `ASSESSMENT_CRYSTALOS.md`, plus first-hand reads of `app/src/styles/theme.css`, `app/src/index.css`, `app/src/lib/brandTheme.ts`, `app/src/lib/i18n.ts`, `app/src/components/AppShell.tsx`, `app/src/components/CrystalPanel.tsx`, `app/src/components/ExperientCopilot.tsx`, `app/src/contexts/crystalPanel.tsx`, `app/src/components/ui/sheet.tsx`, `app/src/__tests__/lib/crystalIdentityTokens.test.ts`, `app/scripts/check-i18n.mjs`, and the **compiled** stylesheet `app/dist/assets/index-YOCsYUQe.css`
> **Library facts verified from:** assistant-ui source (`packages/react/src/primitives/thread/ThreadViewport.tsx`, `.../message/MessageRoot.tsx`, `.../composer/ComposerInput.tsx`), the shadcn registry payload at `https://r.assistant-ui.com/thread`, and `/docs/{primitives,base-ui,rtl,primitives/error,primitives/assistant-modal,ui/markdown,api-reference/primitives/{thread,composition}}.md`

---

## Verdict up front

**`PARTIAL`, and specifically: adopt nothing now. `DON'T` migrate; `DO` fix the platform-hygiene defects the migration question surfaced.**

Confidence **high (~0.85)** on the platform-integration half, which is the half I own.

The accessibility argument is the strongest user-facing case for adoption, and I was hired onto this pod partly to make it. **I cannot.** I verified assistant-ui's a11y posture against its own source rather than its prose, and the finding is: it ships **accessible names**, not **accessible announcements**. `ThreadViewport` sets no `role` and no `aria-*` at all. `MessageRoot` sets no `role` and no `aria-*` at all. The registry-copied styled `thread.tsx` contains **zero** `aria-live`, **zero** `role="log"`, **zero** `role="status"`, and **zero** screen-reader-only announcers. Crystal's single largest a11y defect — a streaming AI answer that is never announced (WCAG 4.1.3) — is **not closed by adoption**. By my count it closes about **1.5 of 14** enumerated defects and introduces **2 new ones**.

Would I approve this dependency in a design-system review? **No — but not on the grounds the evidence base gives.** Full answer in §7.

Along the way I found four errors in our own shared documents and four previously-unnamed **measured** WCAG AA failures. Those are in §0 and §2.4.

---

## 0. Corrections to the shared evidence base

Every one of these is measured, not argued. Two cut in favour of the library and two against.

### (a) `app/CLAUDE.md:73` and `lib/brandTheme.ts:9-10` are factually wrong, and Nadia's §5 objection rests on them

Both documents assert:

> *"Tailwind utilities like `bg-primary` are baked at build time and will NOT update at runtime."*

**This is false in Tailwind v4 as this app is configured.** I checked the compiled artefact rather than reasoning about it:

```
app/dist/assets/index-YOCsYUQe.css
  .bg-primary{background-color:var(--color-primary)}
  .text-primary{color:var(--color-primary)}
```

Tailwind v4 emits utilities as `var()` references, not literals. And there are exactly two declarations of `--color-primary` in the bundle:

| Byte offset | Value | Enclosing block |
|---|---|---|
| 8498 | `#2a4bd9` | `@layer theme { :root, :host { … } }` — **layered** (from `index.css:41`) |
| 140927 | `var(--brand-primary)` | `:root { … }` — **unlayered** (from `theme.css:55`) |

Per the CSS cascade-layers spec, **unlayered declarations win over layered ones at equal specificity.** So `--color-primary` resolves to `var(--brand-primary)`, which `applyBrandTheme()` overwrites on `document.documentElement` (`brandTheme.ts:55`). **`bg-primary` is live-brandable.** I verified the nesting by brace-counting the bundle: the `#2a4bd9` declaration is at depth 2 inside `@layer theme{:root,:host{`; the `var(--brand-primary)` declaration is at depth 1 inside a bare `:root{`.

Two consequences:

1. **Nadia's "real objection to the styled set" (`ASSESSMENT_CRYSTAL_UI.md:312-314`) should be retracted.** Her argument is that registry components ship Tailwind utility classes, therefore *"every copied file needs a hand pass converting brand utilities to CSS-var inline styles."* It doesn't. A copied component using `bg-primary` / `text-primary-foreground` / `border-border` / `bg-muted` inherits Xperiq brand automatically, at runtime, today. I agree with her conclusion (headless-only) but not with this reason, and a design-system review that rejects a dependency on a false premise is a review that gets overturned. My actual objections are in §1.3.
2. **The house rule has cost us real money.** Because the doctrine says "inline `style` or it won't brand," `CrystalPanel.tsx` carries **66 hex literals (28 distinct)** and **27 inline `color-mix(in srgb, …)` expressions** where Tailwind utilities would have worked and would have been lintable. The doctrine produced the untokenised mess the token test then had to police. That is worth fixing on its own merits.

**And here is the specific CSS mechanism that breaks, since my mandate asks for one.** It is not a property — it is a **cascade layer**. The entire runtime-brand system depends on `theme.css` being imported *unlayered* at `index.css:2`. Wrap that import in `@layer base` — or have a future Tailwind/Vite change hoist it into a layer — and `@layer theme`'s literal `#2a4bd9` starts winning, every brand override in the product silently reverts to Xperiq blue, and **no test in the repo notices**, because `crystalIdentityTokens.test.ts` greps `.tsx` source for hex strings and never evaluates a cascade. That is the platform's single most fragile CSS invariant and it is currently undocumented and untested. It is also entirely orthogonal to assistant-ui.

### (b) `CURRENT_STATE.md` §6's "12 `t()` calls" is correct; Nadia's correction to 17 is wrong

`ASSESSMENT_CRYSTAL_UI.md:19` raises the count to 17, citing `:233,398,653,1037,1108`. Those five are substring false positives:

| Line | Actual text | Matched fragment |
|---|---|---|
| `:233` | `new URLSearchParams(location.search).get('mode') === 'support'` | `ge` + `t('` |
| `:398` | `const lines = buffer.split('\n');` | `spli` + `t('` |
| `:653` | `setInput('');` | `setInpu` + `t('` |
| `:1037` | `body.split('\n').map(…)` | `spli` + `t('` |
| `:1108` | `setInput('');` | `setInpu` + `t('` |

The verified 12: `CrystalPanel.tsx:939, 1198, 1204, 1255, 1391, 1409, 1421, 1424, 1429, 1437, 1442, 1488`. Ten of them resolve `crystal.*` keys, two resolve `support.*`. Nine distinct `crystal.*` keys are used app-wide. Direction unchanged; the number matters because §3 turns on it.

### (c) `CURRENT_STATE.md` §7's "4 pages feed `setCrystalData`" is **3**

`AdvancedInsightsPage.tsx:160`, `InsightsDashboardPage.tsx:158,169`, `SurveyIntelligencePage.tsx:150,162,201`. The fourth apparent hit is a comment at `AppShell.tsx:118`. Relevant to §4: the *producer* surface is even narrower than advertised.

Likewise `openCrystal`: **52 lines** contain `openCrystal(` across **24** non-test files, of which 2 are comments (`contexts/crystalPanel.tsx:14`, `CrystalPanel.tsx:217`) → **50 genuine call sites across 22 files**, not "52 across 26."

### (d) "No focus trap, no `aria-modal`, no `role="dialog"`" is listed as a defect. For this component, **two of those three would be defects to add.**

This is the correction I care most about, because the pod is about to buy a library partly to fix something that isn't broken in the way stated.

Crystal is a **non-modal docked complementary panel**: `position: fixed; top: 4rem; right: 0` (`CrystalPanel.tsx:1154-1164`) with **no overlay** — the only scrim is a 64px decorative gradient strip at `:1136-1144`. The page behind stays fully readable and interactive, which is the entire point of a copilot; `AppShell.tsx:56-58` even force-closes it on navigation so the user is expected to be *using the page* while it's open. Applying `role="dialog"` + `aria-modal="true"` + a focus trap to that would **lie to assistive technology** (it would claim the rest of the page is unavailable when it isn't) and would break the primary interaction (reading the report Crystal is discussing). WCAG does not require a focus trap for non-modal content; 2.1.2 arguably discourages one here.

The correct target is `role="complementary"` (or `role="region"`) + `aria-label`, plus a live region, plus focus restoration, plus Escape as an expected-pattern convenience. Nadia reaches the same conclusion at `ASSESSMENT_CRYSTAL_UI.md:347`; Priya still lists focus trap and `aria-modal` as owed work at `ASSESSMENT_CRYSTALOS.md` §6.2 item 3. **I am ruling: they are not owed. Do not build them.**

Also: `CURRENT_STATE.md` §6 says *"Closing does not restore focus"* — true — but the flat claim "no focus trap" sits next to an implication of no focus management at all. `CrystalPanel.tsx:666-671` **does** move focus into the composer 350 ms after open. Focus-in exists; focus-*out* is the gap.

### (e) "9 inline keyframes" is **8**

`CrystalPanel.tsx:1590, 2304, 2308, 2312, 2317, 2321, 2326, 2330`. Confirms Nadia's count.

### (f) The "test-enforced brand token cascade" enforces 7 strings in a file containing 66 colour literals

`crystalIdentityTokens.test.ts:26-27` bans seven hex strings and two `rgba()` decompositions across three files (`:19-23`), excluding `CrystalPanel.tsx:1733-1738`. `CrystalPanel.tsx` contains **66 hex-literal occurrences, 28 distinct**, plus 6 distinct `rgba()` triples. **Exactly one** of those 66 is a banned string, and it lives inside the excluded range (`#2a4bd9` at `:1737`, in `LAYER_COLORS`).

So the guard is green while `#4f46e5` (5×, including the *active brand pill* at `:1321-1322`), `#eef2ff` (3×), `#dc2626` (5×), `#059669` (5×), `#64748b` (3×), `#dfe3e6`, `#b41340`, `#d1fae5` and 20 others sit untouched in the file it guards. Several are *semantic tokens re-hardcoded*: `#dfe3e6` is `--color-surface-container-high`, `#b41340` is `--color-error`, `#d1fae5` is `--color-success-container`, `#059669` is `--color-success`. And the active window-filter pill at `:1321` is hardcoded indigo — a control whose entire job is to read as "brand-selected" and which will not follow a customer's brand.

**The cascade is not test-enforced. Seven strings are test-enforced.** This is a hygiene finding with no bearing on the migration verdict, but it invalidates using "we have a test-enforced token cascade" as an argument in either direction.

---

## 1. Brand-token collision analysis

### 1.1 What Crystal actually reads

| Mechanism | Count in `CrystalPanel.tsx` | Notes |
|---|---|---|
| `var(--color-primary…)` | 51 | live via the unlayered `:root` (§0a) |
| `var(--color-tertiary…)` | 13 | the second brand hue — **no shadcn/Tailwind equivalent exists** |
| `color-mix(in srgb, …)` | 27 (25 lines) | **100% `srgb`**, zero `oklab`/`oklch` |
| `linear-gradient` | 10 | 4 of them `--color-primary → --color-tertiary` (`:1178,1506,1646,2088`) |
| `conic-gradient` | 3 | the brand orb, `MiniCrystal` `:1586-1638` |
| `radial-gradient` | 2 | orb core |

Crystal's visual identity is **not** "primary fill + foreground text." It is a *two-hue gradient system* with low-percentage translucent tints. That distinction is the whole answer to this section.

### 1.2 Can assistant-ui's styled components inherit that cleanly?

**Partly — and much better than `ASSISTANT_UI.md` §6 #5 claims.** I pulled the actual registry payload (`https://r.assistant-ui.com/thread`) rather than trusting either doc. What it consumes:

```
--thread-max-width: 44rem
--composer-bg: color-mix(in oklab, var(--color-muted) 30%, var(--color-background))
--composer-radius: 1.5rem
--composer-padding: 8px
```

plus Tailwind utilities over the standard shadcn token namespace. Xperiq's `index.css:131-141` already defines **every** token that namespace needs — `--color-card`, `--color-muted`, `--color-muted-foreground`, `--color-accent`, `--color-border`, `--color-ring`, `--color-foreground`, `--color-destructive` — and `--color-primary` / `--color-primary-foreground` at `:41,47`. **The token vocabulary matches.** A copied `thread.tsx` would render in Xperiq neutrals and Xperiq brand primary with no wiring at all. I want that on the record because it is the strongest pro-adoption fact in my section and the evidence base got it backwards.

### 1.3 Four things that break anyway

1. **`--composer-radius: 1.5rem` is a hardcoded literal.** `--brand-radius` is a **brandable token** (`theme.css:41`, exposed through `applyBrandTheme()` at `brandTheme.ts:68`). A customer who sets a square-ish brand radius gets a 24 px pill composer that ignores it. Every copied component must be hand-patched to `var(--radius-DEFAULT)` — on arrival and on every registry refresh.
2. **`color-mix(in oklab, …)` vs Xperiq's house `color-mix(in srgb, …)` (27/27).** These are *different interpolation spaces* and produce visibly different results for the same inputs, most at the low mix percentages Crystal lives in (3.5%–18%). An assistant-ui composer tint sitting 8 px from a Crystal header tint mixed in `srgb` will not match. Fixable, but it is a per-file, per-update hand pass — and nothing detects the drift.
3. **`--color-tertiary` does not exist in the shadcn/Tailwind token vocabulary.** Crystal's identity is `primary → tertiary`. The library has no concept of a second brand hue, so every gradient surface — header gem `:1178`, send button `:1506`, user bubble `:1646`, assistant avatar `:2088`, the orb `:1586-1638`, the FAB `AppShell.tsx:145` — must be re-applied by hand on top of the library's flat fills, via `className`/`style` overrides on primitive parts. That means fighting `tailwind-merge` on every composition, and it is where the "wrapper" story collapses into "we restyled all of it."
4. **`applyBrandTheme()` has no contrast guard.** `brandTheme.ts` — I grepped for `contrast|luminance|wcag|a11y`: **NONE**. It writes 15 raw values onto `:root` unvalidated, and `--color-on-primary` / `--color-primary-foreground` are **fixed light values** (`#f2f1ff`) that do not respond to the luminance of the brand a customer picks. A customer setting a light `primary` produces white-on-light everywhere `bg-primary`/`--color-primary-foreground` is used. **assistant-ui makes this worse, not better**, because its styled set uses solid `primary` fills for send/submit controls where Crystal currently uses a gradient with white text over a dark-by-default blue. Adopting a component set that leans harder on `--color-primary` as a *fill* increases exposure to an unguarded brand input.

Bonus defect found in passing: `DEFAULT_BRAND_THEME` (`brandTheme.ts:41-43`) declares `radius: '1rem'`, `radiusSm: '0.5rem'`, `radiusLg: '2rem'`, while `theme.css:41-43` declares `0.75rem / 0.375rem / 1rem`. Calling `applyBrandTheme()` or `resetBrandTheme()` with no argument **silently changes the app's radius scale** away from the CSS defaults. Unrelated to the migration; should be filed.

### 1.4 Wrapper, fork, or neither?

**A wrapper is sufficient for the headless primitives. Neither a wrapper nor a fork applies to the styled set, because there is nothing to fork.**

Nadia is right on the mechanics (`ASSESSMENT_CRYSTAL_UI.md:17`): the styled components are **shadcn-style registry copies**, not imported modules. `/docs/ui/markdown.md`: *"This adds a `/components/assistant-ui/markdown-text.tsx` file to your project, which you can adjust as needed."* Copied code is our code. So:

- **`ASSISTANT_UI.md` §6 argument-against #5 is wrong and should be struck.** Copied files land in `src/components/assistant-ui/`, outside `CRYSTAL_IDENTITY_FILES` (`crystalIdentityTokens.test.ts:19-23`); they cannot fail that test.
- **But the migration breaks that test anyway, and by false positive.** The exclusion is a hardcoded line range, `'src/components/CrystalPanel.tsx': [[1733, 1738]]` (`:43`). Any reflow of the file — a migration, or the monolith split, or both — shifts `LAYER_COLORS` out of `[1733,1738]` and the suite goes red on a line that is *supposed* to keep `#2a4bd9`. The test's own comment says so at `:34-41`. **Fix it to content-match the block; ~10 LOC; do it this week regardless of the verdict.** It will bite the split too.
- **The headless primitives compose cleanly.** `/docs/api-reference/primitives/composition.md`: `asChild`, and *"all props are forwarded, classes are merged, and event handlers are chained."* Verified in source: `MessageRoot.tsx` emits only `data-message-id` / `data-aui-top-anchor-*` and no styling opinions; `ThreadViewport.tsx` renders a bare `Primitive.div`. Our `style` objects and `cn()` classes survive intact. **If any layer of this library were adoptable on design-system grounds, it is this one.**

### 1.5 Section verdict

**No collision that a wrapper cannot absorb — and no benefit that justifies the wrapper.** The token vocabulary matches; the two-hue gradient identity, the `srgb`/`oklab` split, the literal radius, and the unguarded brand input mean every visible surface gets re-styled by hand anyway. We would import a styling system in order to override it everywhere it is visible. That is the definition of a dependency that pays no rent.

---

## 2. Accessibility — quantified

This is the section that was supposed to carry the pro-adoption case. It does not.

### 2.1 What assistant-ui actually provides — verified from source, not prose

The claim under test is `/docs/primitives.md`'s *"unstyled, accessible Radix-style building blocks."* Three findings:

**(i) It is not Radix.** `/docs/primitives.md`, verbatim: *"Every primitive follows the same pattern **inspired by** Radix UI"* (emphasis mine). It is a bespoke implementation that borrows Radix's *composition convention* (`asChild`), not its accessibility engineering. `/docs/base-ui.md` confirms Base UI is an optional shadcn *styling* flavour, not an a11y substrate. The one genuine Radix usage is `AssistantModalPrimitive`, which `/docs/primitives/assistant-modal.md` states is *"built on Radix Popover"* — and Radix Popover defaults `modal={false}`, i.e. **no focus trap, no `aria-modal`**, though it does give Escape-to-close with focus return to the trigger. It is also the wrong shape for a docked panel (§0d), so we would not use it.

**(ii) The primitives set almost no ARIA.** Read directly from source:

| File | ARIA / role | Other |
|---|---|---|
| `primitives/thread/ThreadViewport.tsx` | **none** — no `role`, no `aria-*`, no live region | bare `Primitive.div` + scroll management |
| `primitives/message/MessageRoot.tsx` | **none** | `data-message-id`, `data-aui-top-anchor-user`, `data-aui-top-anchor-target` |
| `primitives/composer/ComposerInput.tsx` | `aria-controls` / `aria-expanded` / `aria-haspopup` / `aria-activedescendant` (only while a mention/slash popover is open) | `useEscapeKeydown()` → cancels *composition*, `cancelOnEscape` default true; autofocus; `unstable_focusOnScrollToBottom` / `unstable_focusOnRunStart` / `unstable_focusOnThreadSwitched`; **no** default placeholder string |
| `ErrorPrimitive.Root` (docs) | `role="alert"` — *"Root renders a `<div>` with `role="alert"` for screen reader accessibility"* | the single documented a11y commitment in the whole primitives page |

**(iii) The styled `thread.tsx` ships names, not announcements.** Full inventory from the registry payload:

- `aria-label="Message input"`, `"Start voice input"`, `"Stop voice input"`, `"Send message"`, `"Stop generating"`, `"Assistant is working"` — **6 `aria-label`s**
- `aria-busy={running}` on `ReasoningContent`, where `running = part.status.type === "running"` — **1 state attribute**
- **`aria-live`: 0. `role="log"`: 0. `role="status"`: 0. `role="alert"`: 0. `aria-atomic`: 0. `sr-only` announcer: 0.**
- **`prefers-reduced-motion` / `motion-safe:` guard: 0**, while using `animate-pulse`, `animate-in`, `animate-out`.

Note the focus-management flags are all `unstable_`-prefixed — i.e. on the surface whose own stability policy says it *"may change in any release including patch releases"* (`ASSISTANT_UI.md:24`).

### 2.2 WCAG 2.1 AA — three-column table

Rows are the success criteria Crystal actually engages. "Gives us by default" = verified above, not claimed.

| WCAG 2.1 SC | Crystal today | assistant-ui by default (**verified**) | What we still owe |
|---|---|---|---|
| **1.3.1** Info & Relationships (A) | Panel container is a bare `motion.div` (`:1148-1165`) with no landmark and no accessible name. "Crystal" is a `<span className="font-black">` (`:1186`), not a heading | **Nothing.** `ThreadViewport` and `MessageRoot` set no `role` and no heading semantics (source-verified) | `role="complementary"` + `aria-label` on the container; promote the title to a real heading and reference it with `aria-labelledby`. **~6 LOC** |
| **1.4.3** Contrast (Minimum) (AA) | **3 measured failures** — see §2.4 | **Nothing** — it inherits our tokens, and its `--composer-bg` recipe adds a fourth low-contrast surface | Fix the 3; add a contrast assertion to `applyBrandTheme()`. **~30 LOC + 1 util** |
| **1.4.11** Non-text Contrast (AA) | Composer field boundary at 14% primary over white = **1.23:1** vs required 3:1 (`:1465`). Panel/header/strip borders 1.05–1.33:1 | **Nothing**, and its own `color-mix(in oklab, --color-muted 30%, --color-background)` composer surface is the same failure mode | Raise the composer boundary to ≥3:1. Decide per-border whether it is decorative. **~10 LOC** |
| **1.4.13** Content on Hover/Focus (AA) | `InlineCitation` tooltip (`:1740-1829`) is hoverable ✓ and focus-triggered ✓ (`:1761-1764`) but **not dismissible via Escape** ✗ and its content is not linked by `aria-describedby` ✗ | **Nothing for our tooltip.** Its own `TooltipIconButton` is a shadcn/Radix Tooltip — correct, but only for *its* controls | Escape-dismiss + `aria-describedby`, **or** replace with Xperiq's existing `ui/tooltip.tsx` (Radix, already a dependency). **~20 LOC** |
| **2.1.1** Keyboard (A) | Passes — everything is a real `<button>` (19 of them) or `<textarea>` | `asChild` preserves native elements | — |
| **2.1.2** No Keyboard Trap (A) | Passes | Passes | **Do not regress this** by adding the focus trap the evidence base asks for (§0d) |
| **2.2.2** Pause, Stop, Hide (A) | 8 `@keyframes`, several `infinite` (`crystal-spin 4s`, `crystal-pulse`, `aurora-flow`, `dot-pulse`, `shimmer-text`). The orb animates for the whole session | **Nothing** — `animate-pulse` on its own "Assistant is working" indicator, unguarded | Argue "essential activity indicator" for the in-flight ones; guard the decorative orb. **~10 LOC** |
| **2.3.3** Animation from Interactions (**AAA**, plus `app/CLAUDE.md:371-383` house rule) | No `prefers-reduced-motion` anywhere in the file | **Nothing** — 0 motion guards in the styled thread (source-verified). **Adoption adds unguarded motion** | One `useReducedMotion()` gate over 8 keyframes. **~30 LOC.** Honest framing: this is a **house-rule violation and a AAA item**, not an AA failure |
| **2.4.3** Focus Order (A) | Focus **does** move into the composer on open (`:666-671`). It is **never restored** to the opener on close | **Partial** — composer autofocus, plus 3 `unstable_focusOn*` flags. **No** focus restoration for a non-modal container it doesn't model | Store the trigger element in `crystalPanel.tsx` and restore on close. **~25 LOC** |
| **2.4.7** Focus Visible (AA) | `focus:outline-none` on the composer textarea (`:1494`) with no substitute ring on the wrapping field | **Partial** — its shadcn-flavoured composer carries `focus-visible` rings, but we restyle the composer regardless | `focus-within` ring on the field wrapper. **~4 LOC** |
| **2.5.3** Label in Name (A) / **1.1.1** (A) | 19 buttons, **12 `title=` attributes, 1 `aria-label`** (`:1765`). `title` *does* compute an accessible name per accname §5.2 step 2I, so this is mostly **not** a hard 4.1.2 failure — it is fragile and touch-invisible | **Closes it for library-owned controls only** — its 6 `aria-label`s cover composer input, send, cancel, dictation. Crystal's Clear / Expand / Close / scope chips / window pills / Pin / Slack / Ticket / thumbs are **ours** | `aria-label` on ~14 of 19 controls. **~14 LOC** |
| **4.1.2** Name, Role, Value (A) | Container has no role (see 1.3.1). Toggle-state controls (window pills `:1316-1326`, Pin) expose no `aria-pressed` | **Nothing** for our controls | `aria-pressed` on 4 pills + Pin; container role. **~8 LOC** |
| **4.1.3** Status Messages (AA) | **The big one.** Zero `aria-live` / `role="log"` / `role="status"` in 2,799 lines. The streaming answer, the 3-phase reasoning timeline, `streamError` (`:1363-1365`), and the proposal Apply spinner are **all silent** | **Nothing.** Source-verified: no live region in `ThreadViewport`, none in the styled `thread.tsx`. `aria-busy` announces *that* it is working, never *what it produced*. `ErrorPrimitive`'s `role="alert"` is real but **off Crystal's path** — Crystal's errors arrive as HTTP-200 SSE `error` events rendered as chat messages (`CURRENT_STATE.md` #12; `crystal.py:1808,1812,1992`), not as runtime errors | `role="log" aria-live="polite"` on the thread container (`:1331`); `role="status"` on the thinking bubble; `aria-live` on `streamError`; `aria-live` on the Apply spinner. **~14 LOC** — and see §6.2, part of the *content* is a contract fix |
| **3.1.2** Language of Parts (AA) | Not engaged — single locale (§3.1). Becomes engaged the moment a second locale ships and model prose stays English | Nothing; no i18n surface at all (§3.2) | Priya's `locale` on `CrystalInput` (`ASSESSMENT_CRYSTALOS.md` §6.2) is the prerequisite |

### 2.3 The scoreboard — how much of the gap does adoption actually close?

Fourteen enumerated defects. Scored against **headless-only adoption** (the only layer I would consider, §1.4):

| Outcome | Count | Which |
|---|---|---|
| **Closed by adoption** | **0** | — |
| **Partially closed** | **3** | 2.5.3/1.1.1 (names — for ~5 of 19 controls); 2.4.3 (autofocus, which we already have); 2.4.7 (rings we'd restyle away) |
| **Wash** (we already have it, or we rebuild it either way) | **2** | focus-into-composer (`:666-671`); focus-visible styling |
| **Still entirely ours** | **9** | 1.3.1, 1.4.3, 1.4.11, 1.4.13, 2.2.2, 2.3.3, 4.1.2, **4.1.3**, 3.1.2 |
| **Newly introduced by adoption** | **2** | unguarded `animate-pulse`/`animate-in`/`animate-out` (2.3.3); a second `oklab` low-contrast surface (1.4.11) |

**Credit-weighted: adoption closes roughly 1.5 of 14 defects — about 10%.** It closes **0%** of WCAG 4.1.3, which is the defect a blind user actually hits: today Crystal produces an answer and says nothing.

Total remaining cost after adopting: **~165 LOC.** Total cost with **no** dependency: **~171 LOC** — and that includes rows the library never touches. Nadia costed the same work at ~110 LOC (`ASSESSMENT_CRYSTAL_UI.md:341-356`); my number is higher because I added the three measured contrast failures, `aria-pressed`, and the heading semantics she didn't enumerate. **Either way it is a two-to-three day task and the delta between the two paths is noise.**

**So: is the a11y case "less than you'd hope"? It is essentially zero.** The premise that a mature chat library solves a11y as table stakes is, for this library, **not true**. `/docs/primitives.md` uses the word "accessible" and commits to exactly one thing behind it: `role="alert"` on an error primitive that Crystal's wire format routes around.

### 2.4 Four measured WCAG AA failures nobody has named

These are new. All computed with the WCAG 2.x relative-luminance formula against the default brand over `#ffffff`.

| # | Where | Computed | Required | SC |
|---|---|---|---|---|
| 1 | `:1494` composer placeholder — `placeholder:text-on-surface-variant/50` → `#595c5e` @ 50% over white | **2.24:1** | 4.5:1 | **1.4.3 FAIL** |
| 2 | `:2498` step-duration text — `text-[10px] tabular-nums`, `--color-on-surface-variant` @ `opacity: 0.65` | **3.01:1** | 4.5:1 | **1.4.3 FAIL** |
| 3 | `:2506` observation summary — same colour @ `opacity: 0.75` | **~3.6:1** | 4.5:1 | **1.4.3 FAIL** |
| 4 | `:1465` composer field border — `color-mix(in srgb, var(--color-primary) 14%, transparent)` over white | **1.23:1** | 3:1 | **1.4.11 FAIL** |

And a fifth, systemic: **the panel uses `text-[10px]` 32 times, `text-[9px]` 4 times.** 10 px chrome at font-weight 700 is legible-ish at 1× but interacts badly with 1.4.4 Resize Text and 1.4.12 Text Spacing, and it is why so many of these contrast numbers are marginal — the design compensates for tiny type with low-contrast greys, which is exactly backwards.

**None of these are fixed by any library.** They are ours, they are measurable, and they are the highest-value a11y work in this assessment after 4.1.3. Priya's §6.2 item 3 hands me *"Escape, focus trap, `role="dialog"`, `aria-modal`, reduced motion"* — two of which I've ruled out (§0d) and none of which is one of these four.

---

## 3. i18n verdict

**A wash, and adopting the library would not make it permanently unfixable. But that framing lets us off the hook. The real bug is `check:i18n`.**

### 3.1 Ground truth, sharper than the evidence base

- `lib/i18n.ts:13` — `const LOCALES = { en }`. **There is exactly one locale.** `setLocale()` (`:35`) silently no-ops for anything else. Every "i18n violation" in Crystal today has **zero user-visible consequence**; the rule is a *seam-preservation* rule, not a working-feature rule. Any argument that hardcoded English "breaks i18n" is arguing about a capability that has never existed.
- `CrystalPanel.tsx` — **12** `t()` calls in 2,799 lines (§0b), resolving 9 distinct `crystal.*` keys + 2 `support.*`.
- `locales/en.ts` holds **6** `crystal:` blocks (`:25, 213, 797, 921, 3018, 3946`) plus `askCrystal` (`:2029`) and `crystalBrief` (`:5320`).
- The root `crystal:` namespace (`:3946-3970`) defines 26 keys. **9 are used.** The 13 under `crystal.tool.*` (`:3947-3961`) are **all dead** — and `TOOL_META` at `:2192-2205` hardcodes English labels for the **same 13 tool names**, with *different wording*: locale says `'Loading survey overview'`, component says `'Reading survey overview'`.
- `ExperientCopilot.tsx` — **0** `t()` calls in 616 lines. 100% hardcoded English.
- `AppShell.tsx:137-138` — `title="Ask Crystal (⌘K)"` and `aria-label="Open Crystal AI assistant"`. Even the shell-level Crystal entry point is hardcoded, *including its one accessibility string*.

### 3.2 Does assistant-ui support string overrides?

**There is no string-override API, and no i18n surface at all.** I checked:

- `/llms.txt` — the doc index lists **no** page for i18n, localization, translations, or string overrides. The single localization-adjacent page is `/docs/rtl.md`.
- `/docs/rtl.md` handles **direction only**: *"Components shipped through `@assistant-ui/ui` … use logical Tailwind classes … They flip automatically under `dir="rtl"`."* It makes no mention of translating UI text or integrating an i18n library. Credit where due: logical properties are the right call and better than several of Xperiq's own hand-positioned surfaces.
- Source-verified partial mitigation: `ComposerInput.tsx` ships **no default placeholder** — it is a prop. Good.
- Source-verified problem: the registry `thread.tsx` hardcodes at least `"How can I help you today?"`, `"Send a message..."`, `"Scroll to bottom"`, `"Voice input"`, `"Stop dictation"`, `"Copy"`, `"Refresh"`, `"More"`, `"Export as Markdown"`, `"Edit"`, `"Cancel"`, `"Update"`, `"Previous"`, `"Next"`, plus the 6 `aria-label`s from §2.1.

### 3.3 Verdict

**Not permanently unfixable — the opposite.** Because the styled components are **registry copies, not imported modules** (§1.4), every hardcoded string lands in a file we own and can `t()` on arrival. That is *structurally better* than a compiled `node_modules` component with no override hook, which is the case that would genuinely poison the seam. And the headless primitives — the only layer I'd consider — contain almost no strings at all.

**So: a wash on the strings, and a mild negative on the discipline.** The negative is not the library's fault: registry copies create ~180–400 LOC of new "someone else wrote this" code that reviewers instinctively treat as vendor code and therefore don't hold to `t()`. That is a predictable social failure, and this repo has already demonstrated it — `ExperientCopilot.tsx` is 616 lines of in-house code with 0 `t()` calls that nobody blocked.

### 3.4 The real bug: `check:i18n` cannot fail on this

`app/package.json:16` defines `"check:i18n": "tsx scripts/check-i18n.mjs"`. I read it. It:

1. flattens `locales/en.ts` into a key set;
2. regex-scans `src/**` for `t('key')` (`check-i18n.mjs:35`);
3. reports **used keys that are not defined**.

That is one direction of one relation. It **structurally cannot detect**:

- **hardcoded user-visible strings** — the actual violation. A file with 0 `t()` calls is the *cleanest possible pass*. `CrystalPanel.tsx` at ~95% hardcoded English and `ExperientCopilot.tsx` at 100% both pass today.
- **dead locale keys** — the reverse direction. The 13 dead `crystal.tool.*` keys and ~80 other unused `crystal:` keys are invisible to it.
- **duplicated copy** — `TOOL_META.label` vs `crystal.tool.*` is exactly the drift a coverage check exists to catch.

**And it is never run.** I grepped `.github/workflows/*.yml` and every script in the repo: `check:i18n` appears **only** in `package.json:16`. `ci.yml` does not invoke it.

> **This is the answer to my mandate's i18n question.** The project rule is real and the tooling that is supposed to enforce it is a missing-key linter that is not wired to CI. **That is the bug — not the library.** Crystal is at 95% hardcoded English because nothing has ever objected. Adopting assistant-ui neither causes that nor cures it; it just adds a fresh batch of unpoliced strings to a repo with an unpoliced string problem.

**Recommended, independent of the verdict, in this order:**

1. **Run `check:i18n` in `ci.yml`.** It already works for what it does. One line.
2. **Add the reverse direction** — report defined-but-unused keys, warn-only at first. It would immediately surface the 13 dead `crystal.tool.*` keys. ~15 LOC in the existing script.
3. **Wire `TOOL_META` to `t('crystal.tool.' + tool)`.** The keys already exist and are already correct English (`en.ts:3947-3961`). This is a **one-expression fix** that deletes 13 hardcoded strings, and it is proof the i18n debt here is *cheap*, not hard.
4. **Add a hardcoded-string heuristic** — flag JSX text nodes and `placeholder=` / `title=` / `aria-label=` string literals over ~3 characters in a defined allowlist of directories, starting with `src/components/crystal/`. Warn-only, ratchet down. ~60 LOC. This is the one that would have prevented all of it.

Step 3 alone takes Crystal from 12 `t()` calls to 25 and kills the duplicate-copy drift, in one line, today.

---

## 4. Blast-radius analysis — the panel's public interface

### 4.1 What the interface is

**Not a component API. A 20-member React context plus 3 props.**

`contexts/crystalPanel.tsx:44-68` exposes: `isOpen`, `initialQuery`, `crystalCtx`, `scope`, `agenticInsights`, `topics`, `openCrystal`, `closeCrystal`, `toggleCrystal`, `setScope`, `setCrystalCtx`, `setCrystalData`, `builderContext`, `builderDraft`, `builderDraftHydrator`, `setBuilderContext`, `setBuilderDraft`, `setBuilderDraftHydrator`. `AppShell.tsx:120` additionally passes `scope`, `surveys`, `insights` as props.

Measured consumer surface (§0c):

| Consumer role | Count | Sites |
|---|---|---|
| **Openers** — `openCrystal(query?, ctx?)` | **50 call sites / 22 files** | 11 in `pages/insights/UnifiedInsightsView.tsx`; 6 in `TopicAnalysisHubPage`; 4 in `ExperienceHubPage`; 3 each in `TopicDeepDivePage`, `SurveyTrendsPage`, `SurveyIntelligencePage`; 2 each in `ResponseDashboardPage`, `TopicsAnalysisPage`, `AdvancedInsightsPage`, `SideNav`; 1 each in 12 more |
| **Scopers** — `setScope` / `setCrystalCtx` | 69 lines | mostly mount/unmount effect pairs |
| **Producers** — `setCrystalData` | **3 pages** | `AdvancedInsightsPage:160`, `InsightsDashboardPage:158,169`, `SurveyIntelligencePage:150,162,201` |
| **Builder co-edit** | 2 pages | `WorkflowBuilderPage`, `WorkflowCanvasPage` (+ `AskCrystalFab`) |
| **Shell** | 1 | `AppShell.tsx:28,57,67,120,136` |

**The critical structural fact: `openCrystal` is a fire-and-forget imperative `(query?, ctx?) => void`.** Callers do not know that a thread, a message array, an SSE stream, or a runtime exists. They pass a string and an optional grounding object. That decoupling is the single best piece of design in Crystal, and it is what makes the blast radius small.

### 4.2 Under migration

| Interface member | Change required at call sites | Change required at the boundary |
|---|---|---|
| `openCrystal(query, ctx)` × 50 | **None.** It maps onto `runtime.thread.append({role:'user', content:[…]})` behind the same signature | Rewrite the `initialQuery` auto-submit effect (`:646-656`) to append to the runtime instead of calling `submitQuery` |
| `closeCrystal` / `toggleCrystal` / `isOpen` | **None** | Panel visibility stays ours — `AssistantModalPrimitive` is a Popover and does not model a docked panel (§0d) |
| `setScope` × 69 | **None** | `scope` feeds `submitQuery`'s body (`:344-377`), which relocates inside `onNew`. Reads the same context |
| `setCrystalCtx` | **None** | same |
| `setCrystalData` × 3 pages | **None** | Same — but note the *conversion* risk: `citation_context` retro-enriches an already-rendered message (`:423-431`), which must survive the `convertMessage` boundary |
| `builderDraftHydrator` | **None** | It is a stored callback invoked from `executeAction` (untouched) |
| `messages` (`:196`, internal) | n/a | **The whole migration.** `useExternalStoreRuntime` + `convertMessage` |
| `AppShell` provider tree | 1 site | `AssistantRuntimeProvider` must nest **inside** `CrystalPanelProvider` (it needs `scope`/`crystalCtx` to build request bodies) but **outside** `CrystalPanel`. Interacts with the `isBuilder` suppression at `AppShell.tsx:43,101-103,119` |

**Blast radius at the call sites: effectively zero. 50 of 50 openers, 69 of 69 scopers, and 3 of 3 producers are untouched.** I want to state that plainly because it is the strongest structural argument *for* the migration in my whole section, and it is not in the evidence base. `ExternalStoreRuntime` + the imperative `openCrystal` façade means this is genuinely a **one-file change** at the public boundary. `README.md` decision test #5 (incremental and reversible) **passes**, and passes more cleanly than anyone has credited.

The cost is entirely *inside* `CrystalPanel.tsx` and its tests — which is Nadia's ~+1,015 LOC — plus one provider-ordering hazard in `AppShell`.

### 4.3 Under a no-dependency refactor

| Interface member | Change |
|---|---|
| All 50 openers, 69 scopers, 3 producers | **None** |
| Context shape | **None** — except **one additive member**: store the opener element for focus restoration (§2.2, 2.4.3). ~6 LOC in `crystalPanel.tsx`, opt-in, no call site touched |
| `AppShell` | **None**, unless we stop force-closing on navigation (`:56-58`) to enable persistence |
| Internal | Split into 9 files behind a barrel (Nadia §6.4); add a11y attributes; add markdown |

### 4.4 Section verdict

**The blast radius is not a differentiator.** Both paths are ~zero at the boundary because `openCrystal` is a well-designed imperative façade. Anyone arguing "we can't migrate, 52 call sites" is wrong, and anyone arguing "the refactor is safer at the boundary" is also wrong. **Decide this on the internals, not the blast radius.** The one genuinely new finding is the `AppShell` provider-ordering hazard, and it is a one-time cost, not a recurring one.

---

## 5. Ruling on `XperiqCopilot`, and the dead-code deletion

### 5.1 The evidence

`components/ExperientCopilot.tsx`, **616 LOC**, exported as `XperiqCopilot` (`:115`). One importer: `pages/SurveyBuilderPage.tsx:20`, rendered at `:2415`. `AppShell.tsx:43` suppresses the global panel on `/surveys/:id/build` and `:64-65` refuses to intercept ⌘K there. Its own message model (`ChatMessage`, `:53-60`), own state (`:116-128`), own ⌘K + **Escape** (`:146-158`).

Measured against the flagship:

| | `CrystalPanel.tsx` | `ExperientCopilot.tsx` |
|---|---|---|
| LOC | 2,799 | 616 |
| `aria-*` attributes | **1** (`:1765`) | **3** (`:282, 360, 601`) |
| Escape-to-close | **no** | **yes** (`:158`) |
| `t()` calls | 12 | **0** |
| Brand tokens | 51 `--color-primary`, 13 `--color-tertiary`, 27 `color-mix` | 45 `--color-primary`, 6 `--color-tertiary` |
| Hex literals | 66 (28 distinct) | 29 (25 distinct) |
| Guarded by `crystalIdentityTokens.test.ts` | yes (7 strings) | **no** |
| Streaming | SSE + REST fallback + legacy REST | single REST `onRefine` |
| Action proposals | 25-type union, 18-branch dispatch | `Recommendation[]` + `onApplyRecommendation` |

Two things jump out.

**First, the "lesser" implementation has strictly better accessibility than the flagship.** Three `aria-label`s vs one; Escape-to-close vs none. Same repo, same team, no library involved. Nadia flagged this to me (`ASSESSMENT_CRYSTAL_UI.md:318`) and she is right that it is the most important a11y fact in the assessment. **A framework does not fix a discipline gap. It relocates it, and charges rent.**

**Second, there is a hole in the brand-token guard.** `ExperientCopilot.tsx` renders `aria-label="Open Crystal — Experient Copilot"` (`:282`) — it is a *Crystal-branded surface* — with 29 hex literals and **no** entry in `CRYSTAL_IDENTITY_FILES` (`crystalIdentityTokens.test.ts:19-23`). In its favour: none of its 29 are banned brand hex (they are greys, ambers, greens, `#818cf8`, `#7c3aed`), so adding it to the list would pass today. But the guard was authored around three files and the Crystal identity surface is at least four.

Also stale: the exported name is `XperiqCopilot` while the file is `ExperientCopilot.tsx` and the aria-label still says "Experient" — the pre-rename brand. That is a user-visible artefact of an incomplete rename, in an accessibility string.

### 5.2 Ruling: **CONVERGE — but as a two-step, and step 1 is not a merge**

**Step 1 (do now, ~1 day, no decision dependency): retire its *duplicated chassis*, keep its *product surface*.**

What is genuinely builder-specific is the ~180 LOC of `RefineResult` / `Recommendation` / compliance-risk / apply-recommendation UI (`:11-60`, plus the recommendation cards). What is duplicated is the other ~430 LOC: message list, composer, autogrow, loading states, ⌘K, FAB, unread badge, mobile handling. That 430 LOC is a *worse* copy of `CrystalPanel`'s equivalent — except for Escape and the aria-labels, where it is better.

Concretely: add `aria-label="Open Crystal"` correction, add it to `CRYSTAL_IDENTITY_FILES`, and either (i) route it through `openCrystal()` with a `surface: 'builder'` context — which the wire format **already supports**, `CrystalPanel.tsx:355-377` and `crystal.py:1776` where *"`surface` hard-forces skill routing"* (`CURRENT_STATE.md` #14) — or (ii) at minimum give `SurveyBuilderPage` the global panel back and render the builder-specific recommendation cards as Crystal `action_proposals`. The `workflow_builder` precedent already exists in the context (`crystalPanel.tsx:41,60-67`: `builderContext`, `builderDraft`, `builderDraftHydrator`) and the workflow builders converged onto the global panel exactly this way (`AppShell.tsx:44-49`). **The survey builder is the last holdout, and the mechanism to fold it in is already built and shipping.**

**Step 2: after convergence, `SurveyBuilderPage` is one more `openCrystal()` caller and there is one chat surface.**

**What each option does to the migration's true scope:**

| Choice | Effect on migration scope |
|---|---|
| **Converge first** (my ruling) | Migration scope is **halved-ish and honest**: one chassis, one message model, one ⌘K owner. Nadia's ~+1,015 LOC stands as written |
| **Leave alone** | Migration scope **roughly doubles**. `XperiqCopilot` either gets its own `ExternalStoreRuntime` + `convertMessage` + custom parts (a second full adapter over a *different* message type and a *non-streaming* transport), or it permanently diverges — and then Xperiq maintains a hand-built chat *and* a library-based chat, with a ⌘K conflict resolved by a path regex (`AppShell.tsx:43`). This is the worst outcome available and it is the default |
| **Retire outright** | Not viable. It carries real builder-only product surface (`RefineResult.changes`, compliance risk, apply-recommendation). Deleting it deletes features |

**Sequencing ruling: convergence must be decided *before* the migration, not after.** Nadia says the same (`ASSESSMENT_CRYSTAL_UI.md:493`). If the pod recommends migration without settling this, it is recommending two migrations and costing one.

### 5.3 Dead-code deletion: **CONFIRMED**

Independently verified:

| File | LOC | Importers outside itself |
|---|---|---|
| `components/IrisChat.tsx` | **316** | **0** |
| `pages/insights/ConversationView.tsx` | **363** | **0** |

**679 LOC. Zero importers — including zero test importers.** Delete today. No decision required, no verdict dependency, and from a design-system standpoint an active liability: `ConversationView.tsx` is a hardcoded design mock (fake NPS answer `:118-136`, hand-rolled bar chart `:139-164`) that a future engineer will find and copy. **Approve unconditionally.**

---

## 6. Cross-checks

### 6.1 With Nadia — headless vs styled

**We agree on the conclusion: headless-only, never the styled set. We disagree on two of her reasons, and one of the disagreements matters.**

| Point | Nadia | Me |
|---|---|---|
| Styled set collides with the token test | Retracts it (`:17`) — registry copies fall outside `CRYSTAL_IDENTITY_FILES` | **Agree, and confirmed.** `ASSISTANT_UI.md` §6 #5 should be struck from the record |
| The migration breaks the token test anyway via the hardcoded `[[1733,1738]]` range | `:308` | **Agree.** Fix it now; the monolith split triggers it too |
| The real objection is that registry components use Tailwind utilities, which are build-time static | `:312-314` | **Disagree — measured false.** `.bg-primary{background-color:var(--color-primary)}` in the shipped bundle, and the unlayered `:root` wins (§0a). Copied components inherit brand primary automatically. Please retract |
| Her `t()` count of 17 | `:19` | **Disagree — 12.** Five substring false positives (§0b) |
| A11y: primitives commit to almost nothing; assistant-ui's own docs don't cover most of it; *"Theo should verify this against the rendered DOM rather than the prose"* | `:316` | **Verified, and worse than she suspected.** Not just undocumented — `ThreadViewport.tsx` and `MessageRoot.tsx` set no ARIA in source, and the styled `thread.tsx` has **zero** live regions and **zero** motion guards. Her ~110 LOC a11y estimate is right in shape; my §2.2 raises it to ~171 because of three unmeasured contrast failures |
| `role="dialog"` would be wrong; non-modal panel | `:347` | **Strongly agree**, and I am ruling it out formally (§0d) so it stops being listed as owed work |
| `XperiqCopilot` bounds the migration and must be decided first | `:493` | **Agree.** Ruling in §5.2: converge, step 1 is decoupling not merging, and the `surface`/`builderContext` mechanism already exists |

**My substantive addition to her §5:** her "headless-only" is a *styling* conclusion. Mine is stronger — **headless-only removes the last remaining reason to adopt at all.** The styled set is where markdown, syntax highlighting, `sources`, `reasoning`, `voice`, and the thread list live; it is the entire off-the-shelf gap-closer list in `ASSISTANT_UI.md` §6 argument-for #1. If we take only the primitives, we are importing a 2.4 MB package with 19 transitive dependencies (including `assistant-cloud`, `zustand`, `zod`, and the monolithic `radix-ui` alongside the 12 individual `@radix-ui/*` packages already installed) in exchange for a viewport scroll manager, a composer, and `asChild` — while writing every custom part ourselves against a seam that rearchitected in v0.11 and v0.14. **Headless-only and "worth adopting" are close to mutually exclusive for this codebase.**

### 6.2 With Priya — are the a11y and i18n gaps frontend-only or contract-shaped?

**Her framing is right, her assignment is off in three specific places. Net: ~85% frontend, ~15% contract, and the contract slice is smaller than she claims but more valuable than she claims.**

**(1) Her item 3 — *"purely his: Escape-to-close, focus trap, `role="dialog"`/`aria-modal`, focus restore, `prefers-reduced-motion`"* — contains two items I am rejecting, not accepting.** Focus trap and `aria-modal`/`role="dialog"` are **wrong for a non-modal docked panel** (§0d). Building them would be an accessibility *regression* dressed as a fix. Escape, focus restore, and reduced motion I accept. Please strike the other two from the plan.

**(2) Her claim that the reasoning timeline is *"otherwise unfixable client-side"* (§6.2 item 1) is wrong for the primary label and right for the rest.** I traced the render path:

```
CrystalPanel.tsx:2423   const meta  = step.tool ? TOOL_META[step.tool] : null;
CrystalPanel.tsx:2433   const label = meta?.label
CrystalPanel.tsx:2434-6              ?? (step.phase === 'synthesizing' ? 'Synthesising answer'
                                      : step.phase === 'observation'  ? 'Processing results'
                                      : step.message ?? 'Reasoning');
```

The displayed label is **already** client-owned and keyed on the machine code `tool`, which the contract **already sends** (`crystal.py:1932-1935` emits `{"type":"thinking","tool":tool_name,"message":…}`). `step.message` — her `f"Fetching {tool_name.replace('_',' ')}..."` — is the **third fallback**, reached only for an unrecognised tool. So the timeline's i18n is fixable **today, client-side, in one expression**: `t('crystal.tool.' + step.tool)`, against keys that already exist at `en.ts:3947-3961`. No contract change required.

She is right about `observation.summary`: `"Found data"` or a raw tool-error string truncated to 200 chars (`crystal.py:1943-1947`) is rendered verbatim at `CrystalPanel.tsx:2504-2507`. **That** is server prose on a display path, and **that** is a CrystalOS defect. Same for the six error sentences (`crystal.py:1808,1812,1992`; `main.py:1806`; `experience.ts:800,828`), which land in a chat bubble.

**So the contract-shaped i18n slice is: `observation.summary` + the 6 error strings. Two frames, not the whole timeline.** Her ~0.5 day estimate is right for what remains.

**(3) On a11y, the contract dependency is real but narrow — and it is about *what* to announce, not *whether*.** I can add `role="log" aria-live="polite"` today in 3 LOC and it will immediately fix the single worst defect (4.1.3 on the streaming answer), because the **answer prose is model output in the user's language** and needs no contract change to be announced. What needs the contract is announcing the *timeline*: a live region reading *"Found data"* or *"Fetching get survey overview…"* is worse than silence, so the polite region should announce the `t()`-resolved tool label (already possible, per (2)) and **suppress** `observation.summary` until it carries a machine code.

**Practical consequence: I do not need to wait for her.** Ship the live region now, scoped to the answer and the `t()`-resolved timeline labels; adopt machine-coded `observation`/`error` frames when her §1 contract PR lands. Nothing blocks nothing.

**(4) Where I fully back her, and it is the most important thing in her document:** `locale` on `CrystalInput` (§6.2 item 2). Model-generated prose — `answer`, `suggestions[]`, and proposal `title`/`description`/`cta_label`/`business_rationale` (`crystal.py:166-172`) — **can never route through `t()`**. It has to be *generated* in the user's language. That makes `locale` the **only** true prerequisite for Xperiq ever shipping a second locale, and it is nearly free to add while the contract is already open. **As the person who owns i18n discipline on this pod: if her PR ships without `locale`, that is the single most expensive omission in the plan.** It also converts my §2.2 row for WCAG 3.1.2 from "not engaged" to "engaged and satisfiable."

**(5) Her strongest self-criticism is aimed at me and it lands.** `ASSESSMENT_CRYSTALOS.md`: *"the contract engineer recommends contract work… my plan makes the contract excellent and leaves the surface hand-built by the same team under the same incentives."* She is right that the organisational failure mode is real. My answer is §3.4: **the reason generic affordances never ship is not that they are hard — it is that nothing objects.** `check:i18n` exists, works for what it does, and is not in CI. There is no a11y check at all. The token test guards 7 strings. **A library is an expensive substitute for a CI gate.** Buy the gate.

---

## 7. Verdict

```
┌──────────────────────────────────────────────────────────────────────────┐
│  VERDICT:      PARTIAL — adopt nothing now; do the platform-hygiene work  │
│  CONFIDENCE:   High (~0.85) on platform integration (design system,       │
│                a11y, i18n, blast radius) — the half I own                 │
│  SCOPE:        Design-system fit, WCAG posture, i18n discipline,          │
│                public-interface blast radius, XperiqCopilot              │
└──────────────────────────────────────────────────────────────────────────┘
```

Against `README.md`'s five tests, from my vantage point only:

| # | Test | My finding |
|---|---|---|
| 1 | Closes a gap a user hits today? | **No, on my two gaps.** A11y: ~1.5 of 14 defects, **0%** of WCAG 4.1.3 (§2.3). i18n: a wash, and the real defect is an un-wired CI script (§3.4) |
| 2 | Replaces more code than it adds? | Nadia's arithmetic. My a11y/i18n delta between paths is **~6 LOC** — noise |
| 3 | Differentiated 40% survives? | Design-system view: **degraded.** The two-hue `primary→tertiary` gradient identity has no token in the library's vocabulary and must be re-applied on every surface (§1.3) |
| 4 | Churn tax acceptable? | Nadia's, and I concur: three of four migrations rearchitected the two seams we'd build on |
| 5 | Incremental and reversible? | **Yes — more cleanly than credited.** 50 openers, 69 scopers, 3 producers: **zero** changes. `openCrystal` is a genuinely good façade (§4.2). This test passes |

### Would you approve this dependency in a design-system review?

**No. And I want to be precise about why, because two of the three obvious reasons are wrong.**

I would **not** reject it for "it can't be themed" — it can; the token vocabulary matches and Tailwind v4 utilities are live-brandable in this app (§0a, §1.2). I would **not** reject it for "hardcoded English poisons i18n" — registry copies are our files and can be `t()`'d on arrival, which is *better* than a compiled component (§3.3).

I would reject it on three grounds:

1. **It does not deliver the capability it is being bought for.** The stated headline benefit in a design-system review would be "accessibility as table stakes." I verified the source: `ThreadViewport` and `MessageRoot` set no ARIA; the styled thread has **zero** live regions and **zero** motion guards; the sole documented commitment is `role="alert"` on a primitive Crystal's wire format routes around. **A dependency that does not deliver its headline capability fails review on that fact alone**, regardless of everything else.
2. **The only layer that survives design-system scrutiny is the layer with no value.** Styled set: rejected (§1.3 — literal radius, `oklab`/`srgb` split, no second brand hue, worsens an unguarded brand input). Headless primitives: accepted on the merits — and they are a viewport scroll manager, a composer, and `asChild`, in exchange for 2.4 MB, 19 transitive dependencies including a commercial cloud client, `zustand`/`zod` as new frontend deps, a duplicate monolithic `radix-ui` next to 12 existing `@radix-ui/*` packages, and a new Vite manual chunk. **The rent exceeds the value by a wide margin.**
3. **We would be buying a dependency to substitute for governance we have not installed.** `check:i18n` exists, works, and is not in CI. There is **no** a11y check anywhere in the repo. `crystalIdentityTokens.test.ts` guards **7 strings** in a file with 66 colour literals (§0f), and its exclusion is a hardcoded line range its own comment calls fragile. `ExperientCopilot.tsx` — a live, Crystal-branded, 616-LOC surface — is not in the guard list at all, and has **better** a11y than the flagship. **Adopting a third-party chassis to fix hand-built-chassis quality, in a repo with no gates on that quality, imports the problem into someone else's code and adds an upgrade treadmill on top.** I have seen this exact review approve this exact dependency and I have seen what it costs eighteen months later.

**My conditional approval, stated as a review outcome:** *Blocked. Re-submit when (a) `check:i18n` and an axe-based a11y assertion run in CI, (b) `crystalIdentityTokens.test.ts` content-matches instead of line-matches and covers all four Crystal-identity files, (c) `applyBrandTheme()` validates contrast, (d) `XperiqCopilot` has converged, and (e) the library has reached 1.0 with the message-part seam and `createMessageConverter` de-`unstable_`'d.* Items (a)–(d) are ours, cost ~4 days total, and are worth doing whether or not (e) ever happens. If (a)–(d) are done and someone still wants (e), I will re-review in good faith — and the review will be much shorter, because the codebase will finally be able to tell us whether the dependency helped.

### The single strongest argument against my own verdict

**My a11y scorecard measures the wrong thing, and if I am wrong it is here.**

I scored assistant-ui on *what it ships today*, defect by defect, and got 1.5 of 14. But an a11y posture is not a snapshot — it is a **rate**. Xperiq's rate on this surface is measurable and it is approximately zero: `CrystalPanel.tsx` is 2,799 lines old, has **one** aria attribute, and sits in a repo that demonstrably knows the patterns — `aria-live` at `insights/TopicChangeBar.tsx:77`, `EnhancedHeaderBand.tsx:149`, `prism/FileDropzone.tsx:301`, `tag-report/PipelineVisualization.tsx:113`, `org-dashboard/HealthPill.tsx:50`, and a correctly-labelled Radix `Sheet` at `insights/InvestigationDrawer.tsx:348-352`. **The panel is surrounded by good practice and has none of it.** assistant-ui, meanwhile, ships six `aria-label`s and an `aria-busy` *unasked*, has `role="alert"` on its error primitive, uses logical properties for RTL correctly, and had accessibility-shaped work merged recently (a `role="status"` live region on its `DotMatrix` indicator, `aria-hidden` on decorative SVG in its generative-UI vocabulary). **Their rate is positive and ours is zero.** On a 3-year horizon a positive rate beats a 1.5/14 snapshot, and my §2.3 arithmetic is exactly the kind of static analysis that loses that argument.

The honest counter to my own §7 point 3 is also uncomfortable: I am saying "buy the gate, not the library." But a gate only forces work someone then has to do, and the reason this work has never been done is that a11y on Crystal has never been anyone's feature. A library makes some of it *free by default* — which, in an organisation where nothing is ever prioritised, beats a gate that generates a backlog. If the pod's read is that the failure here is organisational rather than technical, **Priya's self-criticism and this paragraph point the same way, and my verdict is the wrong one.**

Two secondary arguments against me: (a) I am the person on this pod most likely to over-index on theming risk, and I found the theming risk to be **smaller** than the evidence base claimed — I should update further in that direction than I have; (b) `README.md` test #5 passes cleanly in my §4, and I gave it one line while spending three sections on reasons to decline.

### What would change my mind

1. **A live-region commitment in the library.** `role="log"`/`aria-live` on the thread viewport, or a documented announcer API, shipped and in source — not in prose. That single change moves WCAG 4.1.3 from "0% closed" to "closed," which is 40% of the weight of my §2.3 scorecard on its own. **This is the cheapest thing that would flip me and I would file the issue myself.**
2. **`axe-core` in CI over the current Crystal panel, run monthly for two quarters.** If the violation count does not fall after the ~171 LOC a11y pass — i.e. if we fix it and it regresses — then the "hand-built means permanently inaccessible" thesis is empirically true for this team and I withdraw §7 point 3, which is my load-bearing objection.
3. **A brand-contrast validator in `applyBrandTheme()` that a customer brand actually fails.** If real customer brands break Xperiq's own contrast, the token system is not fit for the styled set *or* for our own components, and the whole §1 analysis needs re-running against a fixed token layer first.
4. **`XperiqCopilot` converged and the monolith split, then a ≤3-day spike** rendering the *unmodified* `CrystalThinkingBubble` and `ActionProposalCard` inside `ThreadPrimitive`. Same experiment Nadia and Priya both asked for. If the differentiated surface survives intact and the adapter is small, my §7 point 2 ("the only adoptable layer has no value") is wrong, because the primitives would have proven they carry the differentiated code for free.

### What to do instead, in order — my lane only

Nadia owns the chat-surface sequence (`ASSESSMENT_CRYSTAL_UI.md:483-491`) and Priya the contract (`ASSESSMENT_CRYSTALOS.md` Appendix). These are the platform items, none of which appear on either list, and all of which are independent of the verdict:

| # | Work | Cost | Why now |
|---|---|---|---|
| 1 | Delete `IrisChat.tsx` + `pages/insights/ConversationView.tsx` (679 LOC, 0 importers) | 30 min | §5.3. No decision required |
| 2 | `crystalIdentityTokens.test.ts:42-44` → content-match `LAYER_COLORS`; add `ExperientCopilot.tsx` to `CRYSTAL_IDENTITY_FILES` | ~20 LOC | §0f, §5.1. Will false-positive on any reflow, including the split |
| 3 | Run `check:i18n` in `ci.yml`; add the defined-but-unused direction | ~20 LOC | §3.4. The rule has never been enforced |
| 4 | `TOOL_META` → `t('crystal.tool.' + tool)` | **1 expression** | §3.4. Deletes 13 hardcoded strings, kills the duplicate-copy drift, and uses keys that already exist |
| 5 | The four measured WCAG failures (§2.4) + `role="log" aria-live="polite"` at `:1331` | ~35 LOC | The highest user-visible a11y value per line in this entire assessment |
| 6 | Remaining a11y pass (§2.2): container role + name, `aria-label` × 14, `aria-pressed` × 5, focus restore, Escape, reduced-motion gate | ~135 LOC | ~2 days. **Explicitly excluding** focus trap and `aria-modal` (§0d) |
| 7 | Contrast validator in `applyBrandTheme()`; fix the radius-default disagreement (`brandTheme.ts:41-43` vs `theme.css:41-43`) | ~60 LOC | §1.3.4. The brand system currently accepts inputs that break AA |
| 8 | Correct `app/CLAUDE.md:73` and `brandTheme.ts:9-10`; **document the unlayered-`theme.css` invariant** and add a test that asserts `--color-primary` resolves through `--brand-primary` after `applyBrandTheme()` | ~30 LOC | §0a. Today the entire runtime-brand system rests on an undocumented, untested cascade-layer ordering |
| 9 | `XperiqCopilot` step 1 — decouple the chassis, route through `openCrystal()` with `surface: 'builder'` | ~1 day | §5.2. Must precede any migration decision or it doubles its cost |
| 10 | Hardcoded-string heuristic in `check-i18n.mjs`, warn-only, scoped to Crystal dirs first | ~60 LOC | §3.4. The gate that would have prevented all of this |

**Items 1–5 are about a day and a half and deliver the entire user-visible a11y and i18n win.** Items 6–10 are roughly four more days and install the governance whose absence is my actual objection to the dependency. **After all ten, re-open the assistant-ui question — and it will be a cheap, honest question instead of an expensive, speculative one.**
