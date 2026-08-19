# Plan — Design System, Accessibility, i18n, Platform Hygiene

> **Author:** Theo Bergmann, Senior Software Engineer (Design Systems & Platform UI), CPACC
> **Layer:** frontend / design systems
> **Mandate:** `TEAM.md` §2 (migration pod, member 2)
> **Charter:** `README.md` — the migration is decided; directive is *styled-first, keep Crystal's look and feel*
> **Date:** 2026-08-04
> **Status:** Plan. No production code written or edited. Deliverable is this document.
>
> **New evidence gathered for this plan** (not in the assessment): live registry payloads for
> `thread`, `styles/default/thread`, `markdown-text`, `reasoning`, `tool-fallback`, `tool-group`,
> `tooltip-icon-button`, `follow-up-suggestions`, `thread-list`, `attachment`, `sources`,
> `shiki-highlighter`, plus `/docs/cli.md`; and a **compiled-bundle measurement** of which
> `--color-*` tokens exist, which are live-brandable, and which Tailwind utilities the app can
> actually generate (`app/dist/assets/index-YOCsYUQe.css`, 164 KB, built 2026-07-14).
>
> **Prior verdict superseded per house rule 5.** My assessment recommended "adopt nothing."
> That recommendation is withdrawn. Three of my own load-bearing facts turned out to be
> incomplete; §1.6 lists what I got wrong and in which direction.

---

## Verdict up front — the styled-component question, answered with a measurement

**STYLED-FIRST IS CORRECT, and it is correct for a reason nobody in the assessment had.**

The precise answer, which is neither "styled" nor "headless" but a seam:

> **Adopt assistant-ui's styled *message-level* parts. Keep Xperiq's own *panel shell*.**
> Five of eleven registry items theme cleanly with **zero** token edits. Three need **≤4 lines**.
> Three must be hand-built — and in all three cases the reason is a **data-model mismatch, not a
> theming failure.** Zero components fail on brand tokens.

The measurement that decides it, run against the shipped bundle:

```
.bg-primary{background-color:var(--color-primary)}          ← live-brandable (theme.css:55, unlayered)
.bg-secondary{background-color:var(--color-secondary)}      ← live-brandable (theme.css:67, unlayered)
.text-tertiary  PRESENT   .from-primary  PRESENT   .to-tertiary  PRESENT
```

`--color-tertiary` is declared **twice**: `index.css:65` (inside `@theme` → `@layer theme`, depth 2)
and `theme.css:78` as `var(--brand-accent)` (**unlayered** `:root`, depth 1). Unlayered wins.
**So Crystal's two-hue `primary → tertiary` gradient identity is expressible as Tailwind utility
classes, live-brandable, today** — `from-primary to-tertiary` are both already in the bundle
(`ui/button.tsx:17` uses them for the `gradient` variant).

That retracts my own strongest objection to the styled set (`ASSESSMENT_XPERIQ_UI.md:137`,
"`--color-tertiary` does not exist in the shadcn/Tailwind token vocabulary"). It doesn't exist in
*shadcn's* vocabulary. It exists in *ours* — and registry copies are compiled by *our* Tailwind
against *our* `@theme`. Re-skinning a copied component to Crystal's identity is a `className`
edit, not an inline-`style` rewrite. That was the entire cost basis of my "we would restyle all of
it" argument, and it is roughly 4× smaller than I costed it.

**Where the real risk turned out to be** — and it is not brand colour:

| Risk | Measured mechanism | Cost |
|---|---|---|
| 5 shadcn tokens the registry uses are **undefined in this app** | `--color-popover`, `--color-popover-foreground`, `--color-card-foreground`, `--color-input`, `--color-secondary-foreground` are absent from the bundle → in Tailwind v4 the utility is **never generated**, so `bg-popover/95` emits *nothing* and the dropdown surface is transparent | 6-line shim, **fixes 2 pre-existing platform bugs** |
| The `animate-in` family **does not exist in this app** | no `tw-animate-css` / `tailwindcss-animate`; `--animate-*` count = 0; `.animate-in`, `.fade-in-0`, `.zoom-in-95`, `.slide-in-from-top-2` all **ABSENT from the bundle despite being used at `ui/dropdown-menu.tsx:45`** | product decision, §5.2 |
| `dark:` compiles to the **OS media query**, and there is no dark theme | `.dark` selector count = **0**; bundle contains `@media (prefers-color-scheme:dark){.dark\:text-amber-400{…}}` → every registry `dark:*` class **fires for OS-dark users** on a light-only app | **1 line** |
| `--color-ring: #2a4bd9` is brand blue **frozen at build time** | declared only inside `@theme` (`index.css:138`), no unlayered alias → `focus-visible:ring-ring/50` in `sources`/`thread-list`/`attachment` will **not follow a customer brand** | 1 line |
| `--composer-radius: 1.5rem` is a literal | ignores `--brand-radius` (`theme.css:41`, brandable via `brandTheme.ts:68`) | 1 line per copy |
| `color-mix(in oklab, …)` vs the house `color-mix(in srgb, …)` (27/27 in `CrystalPanel.tsx`) | different interpolation spaces, visibly different at the 3.5–18% tints Crystal lives in | 1 line per copy |

Every one of those is a **one-time, mechanical, our-file edit**. None requires a fork. None
requires a wrapper. **There is no theming blocker.**

**And the a11y position is unchanged and unchanged deliberately:** a11y is ours to build either
way, ~165 LOC (`ASSESSMENT_XPERIQ_UI.md:221`). The migration does not deliver it. §3 is the build
plan, sequenced so that **every WCAG fix lands on the current panel first** and therefore survives
a kill-switch rollback.

---

## 0. Two platform bugs found while measuring, both live in production today

These are not migration risk. They are current defects, discovered by the same measurement, and
they are why the token-shim work in §2 pays for itself before assistant-ui renders a single pixel.

### (a) `ui/dropdown-menu.tsx` has no background

`ui/dropdown-menu.tsx:45` renders `bg-popover … text-popover-foreground`. Measured against the
bundle: `.bg-popover` **ABSENT**, `.text-popover-foreground` **ABSENT**. The classes are *used in
source*, so Tailwind scanned them and declined to emit — because `--color-popover` and
`--color-popover-foreground` are not in the theme (count = 0 in the bundle). `theme.css:154-155`
defines `--popover` / `--popover-foreground`, which are the **shadcn v3 bare-name aliases**;
Tailwind v4 generates colour utilities from the `--color-*` namespace only.

Corroboration that someone already hit this: `ui/dropdown-menu.tsx:62` — the very next variant —
hardcodes **`bg-white`** instead of `bg-popover`. That is a workaround, not a style choice.

### (b) `<Button variant="secondary">` fails WCAG 1.4.3 at ~2.0:1

`ui/button.tsx:14` — `secondary: "bg-secondary text-secondary-foreground hover:bg-accent"`.

- `.bg-secondary{background-color:var(--color-secondary)}` → `theme.css:67` → `var(--brand-secondary)` → **`#00647c`, brand teal**.
- `.text-secondary-foreground` **ABSENT** (`--color-secondary-foreground` count = 0) → the label falls back to inherited `--color-on-surface` `#2c2f31`.
- Computed contrast, WCAG 2.x relative luminance: **2.00:1** against a required **4.5:1**.

`theme.css:157` intends `--secondary: var(--color-surface-container-low)` (a neutral grey). The
`--color-secondary` in the Tailwind namespace is the *brand teal*. Two different meanings of
"secondary" collided and the utility layer picked the wrong one.

**This is a fifth measured WCAG AA failure, it is platform-wide, and it is not in Crystal.** It
belongs in this plan because `button` is a `registryDependency` of `thread`, `tool-fallback`,
`thread-list`, and `attachment` — we cannot land registry components on top of a broken Button.

---

## 1. The styled-component verdict — per-component table

### 1.1 Method

Registry items were fetched from `https://r.assistant-ui.com/<name>.json`. Per `/docs/cli.md` the
CLI resolves `https://r.assistant-ui.com/styles/{style}/{name}.json`, where `{style}` comes from
`components.json`; **styles prefixed `base-` resolve to Base UI, all others to Radix.**
`app/components.json:4` is `"style": "default"` → **Radix flavour, which matches our 12 installed
`@radix-ui/*` packages.** Good default; no action needed.

For each item I extracted every CSS custom property, `color-mix()` expression, colour/radius/shadow
utility, `aria-*`/`role`, motion class, and user-visible string, then resolved each token against
the compiled bundle. A token is:

- **LIVE** — an unlayered `theme.css :root` alias exists, so `applyBrandTheme()` reaches it: `primary`, `primary-dim`, `primary-container`, `secondary`, `secondary-container`, `tertiary`, `tertiary-container`, `on-primary`, `background`
- **FROZEN-CORRECT** — declared only inside `@theme`, and *should* be static (neutral): `muted`, `muted-foreground`, `accent`, `accent-foreground`, `border`, `foreground`, `card`, `destructive`, `destructive-foreground`
- **FROZEN-WRONG** — declared only inside `@theme`, but holds a brand value that must not be frozen: **`--color-ring: #2a4bd9`** (`index.css:138`), **`--color-primary-foreground: #f2f1ff`** (`index.css:47`, a fixed light value with no luminance guard — `ASSESSMENT_XPERIQ_UI.md:138`)
- **MISSING** — no declaration anywhere; **the utility is not generated at all**: `popover`, `popover-foreground`, `card-foreground`, `input`, `secondary-foreground`

### 1.2 The table

| Registry item | What it gives Crystal | Verdict | Mechanism / edit list |
|---|---|---|---|
| **`follow-up-suggestions`** | maps 1:1 onto `answer.suggestions[]` (`CrystalPanel.tsx:438-461`) | **Themes cleanly as-is — 0 token edits** | Uses only `bg-background`, `hover:bg-muted/80`, `rounded-full`, `border`. All present. Zero `registryDependencies`, one npm dep we already have. **Land this first — it is the cheapest possible proof of the directive.** Owes: 1 `t()` key, and `aria-label` (it ships none) |
| **`markdown-text`** | closes Crystal's single largest user-visible gap (`CURRENT_STATE.md` §6 row 1 — no markdown at all) | **Themes cleanly as-is — 0 token edits** | `border-border/50`, `bg-muted/50`, `text-muted-foreground`, `text-primary`, `border-muted-foreground/30`, `bg-muted/30`, `marker:text-muted-foreground` — all resolve. `rounded-lg` → `--radius-lg: var(--brand-radius-lg)` = **live-brandable**. New npm deps: `@assistant-ui/react-markdown`, `remark-gfm`. Owes: `t('…copy')`; `animate-in zoom-in-75 fade-in duration-150` is inert (§5.2) |
| **`tool-group`** | collapsed "N tool calls" grouping — the shape of Crystal's 3-phase timeline | **Themes after 0 token edits + 6 lines of CSS** | Tokens fine (`border-muted-foreground/30`, `bg-muted/30`). `animate-spin` is native Tailwind ✓. **But `animate-collapsible-up` / `animate-collapsible-down` keyframes do not exist in this repo** (`--animate-*` count = 0) → the collapsible snaps instead of animating. Fix: 2 `@keyframes` + 2 `--animate-*` entries, ~6 LOC, shared with the two rows below. New npm dep: `tw-shimmer`. Owes: 3 `t()` keys with count pluralisation ("tool"/"call"/"calls") |
| **`reasoning`** | collapsible chain-of-thought chassis for `CrystalThinkingBubble` | **Themes after 1 token edit** | `color-mix(in oklab, var(--color-muted) 50%, var(--color-background))` — both tokens exist; **change `oklab`→`srgb`** to match the house 27/27 convention (1 line). `registryDependencies: [collapsible]` — **we already have `ui/collapsible.tsx`** (Radix, `@radix-ui/react-collapsible@1.1.15`) ✓. Needs the same 6 lines of keyframes. **Ships `motion-reduce:animate-none` ×3 and `motion-reduce:transition-none`** — see §1.6(c), this is a correction to my assessment. Owes: 1 `t()` key |
| **`tooltip-icon-button`** | the fix for Crystal's **12 `title=`-only controls** (`ASSESSMENT_XPERIQ_UI.md:202`) | **Themes after 1 import edit** | Only `size-6 p-1` — no colour tokens at all. Wraps Radix Tooltip with an `sr-only` label. **Its npm dep is the monolithic `radix-ui` package, which we do not have** (we have 12 individual `@radix-ui/*`). Fix: repoint the import at `@/components/ui/tooltip` — **1 line, and drop the dep.** This component is a *net a11y gain* and I want it independent of everything else |
| **`tool-fallback`** | **ships a human-in-the-loop approval UI: "Allow / Always allow / Deny / Always deny / Confirm / Back"** | **Themes cleanly as-is — 0 token edits.** Use as the *collapsed/complete* chassis; hand-build the *expanded* card | `bg-muted/50`, `text-foreground/90`, `bg-muted`, `text-muted-foreground` all resolve. This is the single most surprising find in the fetch: the structural match `ASSISTANT_UI.md` §4 predicted is **already implemented in a styled component**. But Crystal's `ActionProposalCard` carries `business_rationale`, `estimated_time`, `priority`, a 25-member type union, and a mandatory 3-status outcome funnel (`CURRENT_STATE.md` §5) — **that stays ours.** Same keyframes + `tw-shimmer`. Owes: 13 `t()` keys |
| **`thread` — Composer sub-tree** | composer field, send/stop button, dictation button | **Themes after 3 edits** | (1) `--composer-radius: 1.5rem` → `var(--radius-DEFAULT)` (brandable, `theme.css:134`); (2) `--composer-bg: color-mix(in oklab, …)` → `srgb`; (3) strip 7 `dark:*` classes or neutralise the variant globally (§2.3). `caret-primary` resolves to LIVE `--color-primary` ✓. Also carries `aria-label="Message input"`, `"Send message"`, `"Stop generating"` — 3 names Crystal lacks |
| **`thread` — ActionBar / BranchPicker / Error sub-trees** | copy / regenerate / error surface | **Themes after 2 edits, but gated on contract** | `bg-popover/95` + `text-popover-foreground` in the "More" dropdown are **MISSING tokens → not generated → transparent menu.** Fixed once by the §2.1 shim. `dark:text-red-200` is a raw Tailwind palette colour, off the token system entirely — replace with `--color-error`. **Functionally blocked**: edit/regenerate need stable message identity (`CURRENT_STATE.md` #6, Priya's G1). Don't land the buttons before the IDs |
| **`thread` — Root / Viewport / Welcome** | full-page chat layout | **MUST NOT ADOPT — hand-built shell stays** | Not a theming failure. `--thread-max-width: 44rem` + a centred viewport + its own welcome screen model a **standalone chat page**. Crystal is a `position: fixed; top: 4rem; right: 0` **non-modal docked panel** (`CrystalPanel.tsx:1154-1164`) with a scope strip, 4 window-filter pills, a header gem, a conic-gradient orb, and a support-mode transport switch. Also carries literal shadows (`shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08)…]`) where we have `--shadow-card`. **Compose `ThreadPrimitive.Viewport`/`Root` headless under our own shell** |
| **`thread-list`** | thread history sidebar | **Themes after 4 token edits — defer to G3** | `bg-popover/95`, `text-popover-foreground` (MISSING → §2.1 shim), `focus-visible:ring-ring/50` (**FROZEN-WRONG** → §2.2). `registryDependencies` include **`skeleton`, which we do not have** → pulls a new shadcn file. **Best a11y of any registry item: `role="status"` + 4 `aria-label`s** — carry that forward. 14 hardcoded strings. Blocked on Priya's thread-persistence ruling (`CURRENT_STATE.md` §4: three implementations, two dead, two schemas disagreeing on identity key) |
| **`sources`** | URL source chips | **MUST GO HEADLESS / HAND-BUILT** | Not a theming failure — a **data-model mismatch.** It renders `{ url, title, favicon }` with `target="_blank"`. Crystal's citations are inline `[uuid]` markers stripped client-side and joined against an out-of-band map injected by *Express, not CrystalOS* (`CURRENT_STATE.md` §2, `experience.ts:782`), resolving to `{headline, survey_title, layer, category, verbatims[], topic_name}`, rendered through **two display strategies selected by scope**, and **retro-enriched onto an already-rendered message** (`CrystalPanel.tsx:423-431`). Keep `InlineCitation` + `SourcesFooter`. (Its tokens *would* be fine: only `bg-muted`, `text-muted-foreground`, `rounded-sm`, plus the FROZEN-WRONG ring) |
| **`attachment`** | file upload chips | **DO NOT ADOPT — needs a product decision** | Crystal has no attachment feature (`CURRENT_STATE.md` §6: no `type="file"`, no `FormData`). Adopting costs: `registryDependencies` include **`avatar`, which we do not have**; new npm dep **`zustand`**; raw literals `bg-black/50`, `after:ring-black/10`, `dark:after:ring-white/10` outside the token system; and `rounded-[calc(var(--composer-radius)-var(--composer-padding))]`. **Flag for PM — this is a new feature wearing migration clothes** |
| **`shiki-highlighter`** | code-block highlighting | **DO NOT ADOPT yet — needs a product decision** | Hardcodes shiki themes `github-dark-default` / `github-light-default` — **non-brand palettes, and `github-dark` in a light-only app.** New npm dep `react-shiki`. Crystal has no emitter that produces code. (Note `syntax-highlighting.json` 404s; the item is named `shiki-highlighter`. `ASSISTANT_UI.md:38` should be corrected) |
| **`assistant-modal`** | popover-hosted assistant | **MUST NOT ADOPT** | Radix Popover (`/docs/primitives/assistant-modal.md`). Wrong shape for a docked non-modal panel — ruling stands (`ASSESSMENT_XPERIQ_UI.md:85`) |

### 1.3 Score

| Outcome | Count | Items |
|---|---|---|
| **Themes cleanly as-is, 0 token edits** | **5** | `follow-up-suggestions`, `markdown-text`, `tool-group`, `tool-fallback`, `thread`/ActionBar-after-shim |
| **Themes after ≤4 lines of edit** | **4** | `reasoning` (1), `tooltip-icon-button` (1), `thread`/Composer (3), `thread-list` (4) |
| **Must be hand-built** | **4** | `thread`/Root+Viewport+Welcome, `sources`, `assistant-modal`, and (deferred, not rejected) `attachment` |
| **Failed on brand tokens** | **0** | — |

**Zero components fail on brand tokens.** Every hand-built row is hand-built because of a
**layout or data-model** mismatch that a design system cannot fix and a fork would not help.
That is the answer to the highest-leverage open question, and it says: **use their UI.**

### 1.4 One conditional to state plainly

`aui-*` class names appear throughout (`aui-button-icon`, `aui-sr-only`, `aui-thread-followup-suggestion`).
These are `data-slot`-style hooks, not styles — harmless, and actually useful as stable selectors
for the characterisation tests Sam owns.

### 1.5 What "keep Crystal's look and feel" costs, concretely

Crystal's identity is **not** "primary fill + foreground text." It is a two-hue gradient system
with low-percentage translucent tints (`ASSESSMENT_XPERIQ_UI.md:118`): 51 `var(--color-primary…)`,
13 `var(--color-tertiary…)`, 27 `color-mix(in srgb, …)`, 10 `linear-gradient` (4 of them
`primary → tertiary`), 3 `conic-gradient`, 2 `radial-gradient`.

Re-applying it on adopted components is now **~14 `className` edits total**, because
`from-primary`, `to-tertiary`, `text-tertiary` and `bg-gradient-to-br` are all already generated
and all live-brandable. The four gradient surfaces (`:1178` header gem, `:1506` send button,
`:1646` user bubble, `:2088` assistant avatar) map onto `bg-gradient-to-br from-primary to-tertiary`
— which is exactly what `ui/button.tsx:17` already does. The orb (`:1586-1638`) and the FAB
(`AppShell.tsx:145`) live in our shell and are untouched.

This is the number I got wrong by ~4× in the assessment.

### 1.6 What I got wrong in `ASSESSMENT_XPERIQ_UI.md`, and in which direction

House rule 2 cuts both ways: an honest cost report includes overstated costs.

**(a) `--color-tertiary` — I said the library's token vocabulary has no second brand hue, therefore
"every gradient surface must be re-applied by hand … where the wrapper story collapses into 'we
restyled all of it'" (`:137`).** Half right. shadcn has no `tertiary`; **our `@theme` does**
(`index.css:65`), with a live unlayered alias (`theme.css:78`), and `.text-tertiary` /
`.to-tertiary` / `.from-primary` are all **PRESENT in the shipped bundle.** Registry copies compile
against our theme. Cost overstated ~4×. **This was my load-bearing objection to the styled set and
it does not hold.**

**(b) `ASSISTANT_UI.md` §6 #5 and my §1.5 both framed theming as the risk.** The measured risk is
**missing tokens and a missing animation plugin** — five undefined `--color-*` and a `tw-animate-css`
that was never installed. Both are ours, both predate assistant-ui, and one of them
(§0a, §0b) is breaking two shipped components right now.

**(c) "The registry ships zero motion guards."** True of `thread.tsx`, which is what I measured.
**Not true of the current registry**: `reasoning.tsx` ships `motion-reduce:animate-none` ×3 and
`motion-reduce:transition-none`. Their reduced-motion posture is better than I reported — and
better than ours, since `prefers-reduced-motion` appears **0 times** in our 164 KB bundle. My
"their rate is positive and ours is zero" self-criticism (`ASSESSMENT_XPERIQ_UI.md:502`) has direct
evidence now.

**(d) Unchanged and re-verified:** `ThreadViewport.tsx` and `MessageRoot.tsx` set no ARIA; the
registry `thread.tsx` has **`aria-live`: 0, `role="log"`: 0, `role="status"`: 0, `sr-only`
announcer: 0**. The 4.1.3 gap is real and is ours. `thread-list.tsx` is the one item that ships
`role="status"`. **The a11y build plan in §3 is unchanged in substance.**

---

## 2. Theming strategy — **edit in place, on top of a one-time token shim**

**Decision: token shim (once, platform-wide) + edit copies in place. No wrappers. No fork.**

### Why not the alternatives

| Option | Rejected because |
|---|---|
| **Wrapper components** | The overrides are on *leaf* elements inside a copied file (composer radius, an `oklab` mix, a `dark:` variant, a literal shadow). A wrapper can only reach the root. Reaching leaves means `className` overrides on primitive parts, which means **fighting `tailwind-merge`** on every composition (`ASSESSMENT_XPERIQ_UI.md:137`) — and `cn()` conflict resolution is order-dependent, so the override silently loses on the next registry refresh. A wrapper also adds a layer reviewers must read to find where a colour comes from |
| **Fork** | **There is nothing to fork.** `/docs/ui/markdown.md`: *"This adds a `/components/assistant-ui/markdown-text.tsx` file to your project, which you can adjust as needed."* Registry items are shadcn-model copies, not imported modules. "Fork" and "edit in place" are the same act |
| **Shim only** | A shim fixes tokens. It cannot fix `--composer-radius: 1.5rem`, `color-mix(in oklab, …)`, `shadow-[…rgba(0,0,0,0.08)]`, or `dark:text-red-200` — those are literals inside component source |

### 2.1 The token shim — 6 lines, in `app/src/styles/theme.css`

Extend the existing shadcn-alias `:root` block (`theme.css:151-170`) to declare the **five missing
`--color-*` names**, aliased to the semantic tokens the bare names already point at:

```
--color-popover, --color-popover-foreground, --color-card-foreground,
--color-input, --color-secondary-foreground
```

Because this block is **unlayered**, these are live-brandable by construction and consistent with
the existing cascade. **This one edit fixes `ui/dropdown-menu.tsx:45` (§0a) and
`ui/button.tsx:14` (§0b) before assistant-ui renders anything.** It is the highest-leverage six
lines in this plan and it is not migration-specific.

`--color-secondary-foreground` must resolve against the *neutral* `--secondary`
(`theme.css:157` = `--color-surface-container-low`), **not** brand teal — see §2.4.

### 2.2 Unlayer the two FROZEN-WRONG tokens — 2 lines

- `--color-ring` → alias to `var(--color-primary)` in the unlayered block, so `focus-visible:ring-ring/50` follows a customer brand instead of being frozen at `#2a4bd9`
- `--color-primary-foreground` → this is the unguarded-brand-input problem (`ASSESSMENT_XPERIQ_UI.md:138`). Aliasing it to `var(--color-on-primary)` makes it *brandable*, which is necessary but **not sufficient** — it still has no luminance guard. The guard is §5.5

### 2.3 Neutralise the `dark:` variant — 1 line

`@custom-variant dark (&:where(.dark, .dark *));` in `index.css`.

Measured justification: `.dark` selector count = **0**, yet the bundle contains
`@media (prefers-color-scheme:dark){.dark\:text-amber-400{…}}`. Tailwind v4 defaults `dark:` to the
OS media query. **Today, three of our own files' `dark:` classes already fire for OS-dark users on
a light-only app**, and every registry component would add more (`dark:shadow-none` removes the
composer shadow, `dark:bg-destructive/5`, `dark:text-red-200`, `dark:border-muted-foreground/15`).
One line makes them all inert until we deliberately ship a `.dark` theme. **This is a bug fix that
happens to also de-risk the migration.**

### 2.4 The registry landing checklist — the durable mechanism

Every registry item lands through the same checklist. It is short, mechanical, and reviewable — and
it is the answer to "who catches drift on the next `npx assistant-ui add`."

1. `oklab` → `srgb` in every `color-mix()`
2. `--composer-radius` / hardcoded `rem` radii → `var(--radius-DEFAULT)` / `var(--radius-lg)`
3. `shadow-[…rgba(…)]` → `var(--shadow-card)` / `--shadow-primary`
4. raw palette colours (`text-red-200`, `bg-black/50`) → `--color-error` / token equivalents
5. `bg-secondary` → **verify intent**: shadcn means *neutral*, our `--color-secondary` is *brand teal* (§0b). Use `bg-muted` when neutral is meant
6. every user-visible string → `t()` (§4)
7. every icon-only control → `TooltipIconButton` or `aria-label`
8. every `animate-*` → resolved per §5.2
9. Crystal gradient surfaces → `bg-gradient-to-br from-primary to-tertiary`

**Enforcement:** a Vitest guard over `src/components/assistant-ui/**` asserting **no `in oklab`, no
`rgba(`, no `text-red-`, no `bg-black/`, no bare `rem` radius literal, and no JSX string literal
outside `t()`** — ~40 LOC, same shape as `crystalIdentityTokens.test.ts` but content-matched rather
than line-matched. This is the "governance we have not installed" objection from my assessment
(`:494`), installed. **It is a G0 deliverable, not a follow-up.**

### 2.5 Version discipline at the design-system seam

Registry copies have **no version.** Once copied there is no upgrade path and no diff — which is
exactly why the checklist has to be a test rather than a wiki page. Record in each file's header
the registry URL and the fetch date; Sam's churn runbook (`TEAM.md` §4) owns the npm pin. My ask on
that seam: **the pinned `@assistant-ui/react` version and the registry fetch date must move
together**, because a registry refresh can assume primitive props that a pinned package does not
have.

---

## 3. The accessibility build plan

**Premise, restated because it is the honest one:** assistant-ui closes ~1.5 of 14 enumerated
defects and **0% of WCAG 4.1.3** (`ASSESSMENT_XPERIQ_UI.md:219`). Total remaining cost after
adopting: **~165 LOC**; with no dependency, **~171 LOC**. The delta is noise. **A11y is ours to
build. The migration neither helps nor hurts it.**

Two things adoption *does* contribute, now verified: 6 `aria-label`s + `aria-busy` on
library-owned controls; `role="status"` and 4 `aria-label`s in `thread-list`; `motion-reduce:`
guards in `reasoning`; correct logical properties for RTL. Carry all of it forward.

### 3.0 The sequencing rule that matters more than any individual fix

> **Every a11y fix lands on the *current* `CrystalPanel.tsx` first, behind no flag.**

Rationale: the plan mandates a kill-switch at every phase (`README.md` constraint 1). If a WCAG fix
lives only in the new chassis, **flipping the kill-switch reverts an accessibility fix** — which is
both a user harm and, once we have a conformance statement, a compliance regression. Landing a11y
on the old panel also gives Sam a **measurable parity baseline**: the new chassis must match an
axe-clean old panel, not an unmeasured one.

Cost of this rule: some a11y work is done twice (once on the old panel, once re-expressed on the
new one). I estimate **~25 LOC of genuine duplication** — the announcer, which is a standalone
component consumed by both. That is the right price.

### 3.1 The `aria-live` announcer for streaming — WCAG 4.1.3 (AA)

**This is the defect a blind user actually hits: today Crystal produces an answer and says nothing.**
Zero `aria-live` / `role="log"` / `role="status"` in 2,799 lines.

New file: `app/src/components/crystal/CrystalAnnouncer.tsx` — **~45 LOC.**

```
<div role="log" aria-live="polite" aria-atomic="false" className="sr-only">
```

Announcement policy, and the reason for each rule:

| Event | Announce | Why |
|---|---|---|
| `answer` (`CrystalPanel.tsx:438-461`) | full answer text, once | Model output is already in the user's language; no contract change needed (`ASSESSMENT_XPERIQ_UI.md:452`) |
| `thinking` (`:432-433`) | `t('crystal.tool.' + step.tool)` | The 13 keys already exist at `en.ts:3947-3959` and the wire already carries `tool` (`crystal.py:1932-1935`) |
| `observation.summary` (`:434-435`) | **suppressed** | It is raw server prose — `"Found data"` or a tool-error string truncated to 200 chars (`crystal.py:1943-1947`). **A live region reading that is worse than silence.** Un-suppress when Priya's contract gives it a machine code |
| `streamError` (`:1363-1365`) | separate `role="alert"` node | Errors arrive as HTTP-200 SSE events rendered as chat messages, so `ErrorPrimitive`'s `role="alert"` is off Crystal's path entirely |
| proposal Apply spinner (`:2783`) | `aria-live="polite"` on the button's status text | Currently a silent spinner |

**A genuine and non-obvious asset: Crystal's lack of token streaming is a WCAG *advantage*.**
A token-streaming chat must throttle or debounce its live region or screen readers stutter
unusably. Crystal emits **one atomic `answer` frame** (`crystal.py:1968`) — the ideal shape for
`aria-live="polite"`. The property that looked like a deficiency in `CURRENT_STATE.md` §2 is the
reason our 4.1.3 fix is 45 LOC instead of a research project. **This is also an argument against
ever emitting token deltas (Priya's ruling), on accessibility grounds.**

### 3.2 The four measured contrast failures — WCAG 1.4.3 / 1.4.11 (AA)

All computed with the WCAG 2.x relative-luminance formula against the default brand over `#ffffff`.

| # | Where | Now | Fix | After | LOC |
|---|---|---|---|---|---|
| 1 | `CrystalPanel.tsx:1494` composer placeholder — `placeholder:text-on-surface-variant/50` | **2.24:1** | drop the `/50` alpha | **6.27:1** ✓ | 1 |
| 2 | `:2498` step-duration — `--color-on-surface-variant` @ `opacity: 0.65` | **3.01:1** | remove `opacity` | **6.27:1** ✓ | 1 |
| 3 | `:2506` observation summary — same colour @ `opacity: 0.75` | **~3.6:1** | remove `opacity` | **6.27:1** ✓ | 1 |
| 4 | `:1465` composer field border — `color-mix(in srgb, var(--color-primary) 14%, transparent)` | **1.23:1** (needs 3:1) | **needs design sign-off** — see below | 3:1+ | 1 |
| 5 | `ui/button.tsx:14` `variant="secondary"` (**platform-wide, §0b**) | **2.00:1** | §2.1 shim points `--color-secondary-foreground` at the neutral pair | ✓ | 0 (shim) |

**#4 is the one I will not decide alone.** Two options, both 1 line:

- **(a)** `border: 1px solid var(--color-outline)` → `#747779` over white = **4.51:1** ✓. Loses the brand tint on the field boundary.
- **(b)** raise the mix to **≥65% primary** → **~3.2:1** at 65%, **3.58:1** at 70%. Keeps the brand tint but the border becomes visually heavy — a noticeably different composer.

I recommend **(a)**, because the field already has a tinted *background* (`:1464`, 4% primary) that
carries the brand read, and 1.4.11 is about *boundary* identification. **But this is a visible
change to the most-looked-at control in Crystal and it belongs to a designer, not to me.**

**And the systemic root cause, which no single fix addresses:** the panel uses `text-[10px]` **32
times** and `text-[9px]` **4 times**. Ten-pixel chrome interacts badly with 1.4.4 Resize Text and
1.4.12 Text Spacing, and it is *why* these numbers are marginal — the design compensates for tiny
type with low-contrast greys, which is backwards. **Fixing the type scale is a visual redesign of
the panel. It is a product decision, it is real, and I am not defaulting it.**

### 3.3 `prefers-reduced-motion` — WCAG 2.3.3 (AAA) + `app/CLAUDE.md` house rule

Measured: **`prefers-reduced-motion` appears 0 times in the entire 164 KB bundle.** Eight inline
keyframes in `CrystalPanel.tsx` (`:1590, 2304, 2308, 2312, 2317, 2321, 2326, 2330`), several
`infinite`; the orb animates for the whole session.

Plan, **~30 LOC**:
1. `useReducedMotion()` (Framer Motion already exports it; `framer-motion@12.38.0` is installed) gates the decorative orb and the 8 keyframes
2. A **global** `@media (prefers-reduced-motion: reduce)` block in `index.css` neutralising `animation` and `transition` platform-wide, ~8 LOC. This is the piece that makes §5.2's animation-plugin decision safe *and* fixes every other surface in the app at the same time
3. Keep in-flight activity indicators animating and argue "essential activity indicator" under 2.2.2 — that is a defensible reading, and stopping the *only* signal that Crystal is working would be worse

**Honest framing, unchanged from my assessment:** this is a **AAA item and a house-rule violation**,
not an AA failure. It ranks below §3.1 and §3.2.

### 3.4 Escape-to-close and focus restoration — WCAG 2.4.3 (A)

- **Escape** (~10 LOC): `CrystalPanel.tsx` has none. **`ExperientCopilot.tsx:152` already has it** — port that implementation, don't invent one (§6)
- **Focus restoration** (~25 LOC): focus-*in* already exists (`:666-671`, 350 ms after open). Focus-*out* is the gap. Store the opener element in `contexts/crystalPanel.tsx` and restore on close — **one additive context member, zero call sites touched** across all 50 `openCrystal()` sites

### 3.5 Explicitly NOT owed — my ruling, restated so it stops reappearing

**No focus trap. No `aria-modal`. No `role="dialog"`.**

Crystal is a **non-modal docked complementary panel** — `position: fixed; top: 4rem; right: 0`
(`:1154-1164`), **no overlay** (the only scrim is a 64 px decorative gradient strip at `:1136-1144`),
and `AppShell.tsx:56-58` force-closes it on navigation precisely because the user is expected to be
**using the page** while it is open. `role="dialog"` + `aria-modal="true"` would **lie to assistive
technology** — claiming the rest of the page is unavailable when it is not — and a focus trap would
break the primary interaction: reading the report Crystal is discussing. WCAG requires no trap for
non-modal content; 2.1.2 arguably discourages one here.

The correct target is `role="complementary"` + `aria-label`, a real heading referenced by
`aria-labelledby`, the live region, focus restoration, and Escape as an expected-pattern
convenience. Nadia agrees (`ASSESSMENT_CRYSTAL_UI.md:347`). **Priya's `ASSESSMENT_CRYSTALOS.md`
§6.2 item 3 still lists focus trap and `aria-modal` as owed work — strike both from the plan.**

### 3.6 The rest, and the gate map

| Item | SC | LOC | Gate |
|---|---|---|---|
| `role="log" aria-live="polite"` announcer (§3.1) | **4.1.3 AA** | 45 | **G1** |
| 4 measured contrast fixes (§3.2 #1–3 now, #4 on design sign-off) | 1.4.3 / 1.4.11 AA | 4 | **G1** |
| `--color-secondary-foreground` shim (§0b) | 1.4.3 AA | 0 (in §2.1) | **G0** |
| `role="complementary"` + `aria-label` + real heading + `aria-labelledby` | 1.3.1 A | 6 | **G1** |
| `aria-label` on ~14 of 19 controls (12 are `title=`-only) — via `TooltipIconButton` | 2.5.3 / 1.1.1 A | 14 | **G2** |
| `aria-pressed` on 4 window pills (`:1316-1326`) + Pin | 4.1.2 A | 8 | **G2** |
| Escape-to-close (port `ExperientCopilot.tsx:152`) | 2.4.3 A | 10 | **G1** |
| Focus restoration via context (§3.4) | 2.4.3 A | 25 | **G2** |
| `focus-within` ring on the composer field wrapper (`:1494` has `focus:outline-none` with no substitute) | 2.4.7 AA | 4 | **G1** |
| `prefers-reduced-motion` gate + global reduce block (§3.3) | 2.3.3 AAA | 30 | **G2** |
| `InlineCitation` tooltip (`:1740-1829`): Escape-dismiss + `aria-describedby` — or replace with `ui/tooltip.tsx` | 1.4.13 AA | 20 | **G3** |
| `axe-core` assertion in CI over the panel | — | 25 | **G2** |
| `locale` on `CrystalInput` (Priya's) | 3.1.2 AA | — | **G1**, hers |
| **Total (my lane)** | | **~191** | |

191, not 165 — the delta is `axe-core` in CI (25) and the shim. **The CI gate is the most important
line in the table** and it was the load-bearing item in my "buy the gate, not the library"
objection. We are now doing both, which is the honest resolution: **the library is bought; the gate
still has to be installed, because §1.6(d) shows the library does not deliver 4.1.3.**

---

## 4. The i18n plan

### 4.1 The structural fact that makes this cheap

**Registry copies are our files, so every string is `t()`-able on arrival.** That is *structurally
better* than a compiled `node_modules` component with no override hook — which is the case that
would genuinely poison the seam. assistant-ui has **no string-override API and no i18n surface at
all** (`/llms.txt` lists no localization page; `/docs/rtl.md` handles direction only) — and it does
not matter, because we own the files.

Ground truth: `lib/i18n.ts:13` — `const LOCALES = { en }`. **There is exactly one locale**, and
`setLocale()` no-ops for anything else. Every i18n violation today has **zero user-visible
consequence.** The rule is a **seam-preservation** rule. Treat it as such and it stays cheap;
pretend it is a working feature and the plan loses credibility.

### 4.2 Strings arriving with the migration

Counted from the fetched payloads: **~55 hardcoded English strings** across the items we intend to
land, plus 6 `aria-label`s.

| Item | Strings | New locale keys |
|---|---|---|
| `thread` (composer/actionbar/branch) | 16 + 6 `aria-label` | `crystal.ui.*` — 22 |
| `thread-list` | 14 | `crystal.threads.*` — 14 (G3) |
| `tool-fallback` | 13 | `crystal.tool.approval.*` — 13 |
| `attachment` | 8 | deferred (product decision) |
| `tool-group` | 3 (need count pluralisation) | `crystal.tool.group.*` — 3 |
| `reasoning` | 2 | `crystal.reasoning.*` — 2 |
| `markdown-text` | 1 | `common.copy` (may already exist) |
| `follow-up-suggestions` | 0 | — |

**Routing rule, enforced by the §2.4 guard test:** no registry file may contain a JSX text node or a
`placeholder=` / `title=` / `aria-label=` string literal longer than 3 characters. **A file fails
review until its strings are keys.** This is the discipline `ExperientCopilot.tsx` proves we do not
have by convention alone — **616 lines of in-house code, 0 `t()` calls, and nobody blocked it.**

`aria-label`s are the ones people forget, and they are the ones that matter most: `AppShell.tsx:138`
ships `aria-label="Open Crystal AI assistant"` hardcoded — **the shell-level Crystal entry point has
exactly one accessibility string and it is not translatable.**

### 4.3 The `TOOL_META` fix — one expression, verified key-for-key

`CrystalPanel.tsx:2192-2205` hardcodes English labels for **13** tool names.
`en.ts:3947-3959` defines **the same 13 keys**, already in correct English, **all dead.** I verified
the sets match exactly:

```
get_survey_overview, get_topic_details, get_metric_history, get_insights_list,
get_verbatims, get_benchmark_comparison, get_driver_analysis, get_segment_breakdown,
get_checkpoint_history, compare_surveys, get_org_portfolio, get_cross_survey_themes,
get_anomaly_events
```

The wording differs — locale says `'Loading survey overview'`, component says
`'Reading survey overview'`. **That is duplicated copy already drifting.**

The render path (`:2423`, `:2433-2436`) resolves `TOOL_META[step.tool].label` first and falls back to
`step.message` only for an unrecognised tool. So the fix is:

> `t('crystal.tool.' + step.tool)` with the existing `meta.label` chain as fallback.

**One expression.** Deletes 13 hardcoded strings, kills the drift, takes Crystal from 12 `t()` calls
to 25, requires **no contract change** — and directly powers the §3.1 announcer, which needs a
translatable tool label to announce. It also **retracts Priya's claim** that the reasoning timeline's
i18n is "otherwise unfixable client-side" (`ASSESSMENT_CRYSTALOS.md` §6.2 item 1) — the displayed
label is already client-owned and keyed on the machine code the wire already sends
(`crystal.py:1932-1935`).

**Lands G1. It is the single best cost-to-value line item in my entire lane.**

### 4.4 The root cause: `check:i18n` cannot fail, and is never run

I read `app/scripts/check-i18n.mjs` (51 lines). It:
1. flattens `locales/en.ts` into a key set (`:24`);
2. regex-scans `src/**` for `t('key')` (`:37`);
3. reports **used keys that are not defined** (`:46-50`).

One direction of one relation. It **structurally cannot detect**:
- **hardcoded user-visible strings** — the actual violation. **A file with 0 `t()` calls is its cleanest possible pass.** `CrystalPanel.tsx` at ~95% hardcoded English and `ExperientCopilot.tsx` at 100% both pass today
- **dead locale keys** — the 13 dead `crystal.tool.*` and ~17 other unused `crystal:` keys are invisible
- **duplicated copy** — `TOOL_META.label` vs `crystal.tool.*` is precisely the drift a coverage check exists to catch

**And it is never run.** `check:i18n` appears **only** at `app/package.json:16`. `.github/workflows/ci.yml`
runs `npm run lint` (`:38`), `npm run test:coverage` (`:44`), `npm run build:app` (`:47`) — **and
nothing else.** `check:i18n` is not in `ci.yml`, `deploy-oci.yml`, `doc-refresh.yml`, or
`support-deploy.yml`.

**Crystal is at ~95% hardcoded English because nothing has ever objected.** Adopting assistant-ui
neither causes that nor cures it. Fix, in order:

| # | Fix | LOC | Gate |
|---|---|---|---|
| 1 | Add `npm run check:i18n` to `ci.yml`. It already works for what it does | **1** | **G0** |
| 2 | Add the reverse direction — report defined-but-unused keys, warn-only. Immediately surfaces the 13 dead `crystal.tool.*` | ~15 | **G1** |
| 3 | `TOOL_META` → `t('crystal.tool.' + tool)` (§4.3) | **1 expr** | **G1** |
| 4 | Hardcoded-string heuristic: flag JSX text nodes and `placeholder=`/`title=`/`aria-label=` literals >3 chars, warn-only, **allowlisted to `src/components/assistant-ui/` and `src/components/crystal/` first**, then ratchet outward | ~60 | **G2** |

**#4 is the gate that would have prevented all of this**, and scoping it to the two migration
directories first is what makes it shippable rather than a 200-violation backlog nobody merges.

---

## 5. Platform hygiene that must land *inside* the migration

Not "adjacent work." Each item below is something the migration **silently depends on** or
**actively breaks**. Deferring any of them converts a 3-day phase into a 5-day debugging session.

### 5.1 Document and test the unlayered `theme.css` import — the platform's most fragile invariant

**The entire runtime-brand system depends on `theme.css` being imported *unlayered* at
`index.css:2`.** Measured from the bundle: `--color-primary` is declared twice — `#2a4bd9` at byte
8498 inside `@layer theme { :root, :host { … } }` (depth 2, from `index.css:41`) and
`var(--brand-primary)` at byte 140927 inside a bare `:root { … }` (depth 1, from `theme.css:55`).
Per the CSS cascade-layers spec, **unlayered declarations win over layered ones at equal
specificity.**

Wrap that import in `@layer base` — or have a future Tailwind/Vite change hoist it into a layer —
and `@layer theme`'s literal `#2a4bd9` starts winning. **Every brand override in the product
silently reverts to Xperiq blue, and no test in the repo notices**, because
`crystalIdentityTokens.test.ts` greps `.tsx` source for hex strings and never evaluates a cascade.

Undocumented and untested today. **The migration makes it load-bearing for a second reason:**
`bg-primary`, `from-primary`, `to-tertiary`, `bg-secondary` and the §2.1 shim tokens in registry
components all resolve through it. Under the old inline-`style` doctrine a layering accident would
have broken only CSS rules; after this migration it breaks **utility classes across every adopted
component too.**

**Deliverable (~30 LOC, G0):**
- a comment block at `index.css:1-2` stating the invariant and why the import must not be layered
- a jsdom test: `applyBrandTheme({ primary: '#e63946' })` → assert `getComputedStyle(document.documentElement).getPropertyValue('--color-primary')` resolves through `--brand-primary`, and that an element with `className="bg-primary"` computes to the new brand — **the first test in the repo that evaluates the cascade instead of grepping source**

### 5.2 The animation-plugin decision — **needs a product decision**

Measured: `.animate-in`, `.animate-out`, `.fade-in-0`, `.zoom-in-95`, `.slide-in-from-top-2` are
**all ABSENT from the bundle** despite being used at `ui/dropdown-menu.tsx:45` and in
`popover.tsx`, `sheet.tsx`, `tooltip.tsx`, `dialog.tsx`, `select.tsx`. `--animate-*` count = 0.
**No `tw-animate-css`, no `tailwindcss-animate`.** Six shipped shadcn components have dead
animation classes today, and `animate-collapsible-up/down` (needed by `reasoning`, `tool-fallback`,
`tool-group`) has no keyframes.

| Option | Consequence |
|---|---|
| **(a) Install `tw-animate-css` + define the 2 collapsible keyframes** (~10 LOC) | Registry components animate as designed, **and six existing shadcn components start animating for the first time.** That is a **visible, platform-wide change to menus, dialogs, sheets, tooltips and selects** with no designer in the loop. Also adds unguarded motion → must ship with §3.3's global reduce block |
| **(b) Strip `animate-*` from every registry copy** (~2 LOC per file, forever) | No visual change anywhere. Registry components appear/disappear instantly. Adds a permanent line to the §2.4 checklist and leaves the six existing components broken |
| **(c) Define only `animate-collapsible-*` keyframes** (~6 LOC) | Minimum viable: collapsibles animate, entrance animations stay inert. Least visual risk, no new dep |

**My recommendation: (c) for G0/G2, revisit (a) at G3 with a designer.** (a) is the technically
correct end state and it fixes a real pre-existing defect — but "six shared components start
animating" is a design decision, not an engineering one, and I am not defaulting it. **Flagged for
PM/design.**

### 5.3 `crystalIdentityTokens.test.ts` — the hardcoded line range will go red

`crystalIdentityTokens.test.ts:42-44`:

```
const EXCLUDED_LINE_RANGES: Record<string, Array<[number, number]>> = {
  'src/components/CrystalPanel.tsx': [[1733, 1738]],
};
```

This excludes the `LAYER_COLORS` block, which is **supposed** to keep `#2a4bd9` (an insight-layer
categorical palette, not brand chrome). **Any reflow of `CrystalPanel.tsx` shifts `LAYER_COLORS`
out of `[1733, 1738]` and the suite goes red on a line that is correct.** The migration reflows the
file on day one; so does the monolith split. The test's own comment admits it
(`:35-41`: *"a hardcoded line range is inherently this fragile across any merge that adds content
above it"*), and records that it was already re-pointed once, on 2026-07-03, from `[1668, 1673]`.

**Fix (~10 LOC, G0):** content-match the `LAYER_COLORS` declaration block — find the
`const LAYER_COLORS` line, exclude to its closing brace. **This must land before any code moves, or
the first migration PR fails CI for a reason unrelated to the migration** and the pod spends half a
day on it.

### 5.4 Add `ExperientCopilot.tsx` to `CRYSTAL_IDENTITY_FILES`

`crystalIdentityTokens.test.ts:19-23` guards **3** files: `CrystalPanel.tsx`,
`workflow-builder/AskCrystalFab.tsx`, `dashboard/widgets/CrystalNarrativeWidget.tsx`.

`ExperientCopilot.tsx` renders `aria-label="Open Crystal — Experient Copilot"` (`:282`) — it is
**a Crystal-branded surface** — with 29 hex literals and **no entry in the guard.** In its favour:
none of its 29 are banned brand hex (greys, ambers, greens, `#818cf8`, `#7c3aed`), so **adding it
passes today.** ~2 LOC, G0. The guard was authored around three files and the Crystal identity
surface is at least four.

While there: the exported name is `XperiqCopilot`, the file is `ExperientCopilot.tsx`, and the
`aria-label` still says **"Experient"** — the pre-rename brand, user-visible, **in an accessibility
string.** Fix in the same PR.

**And the honest limit of this guard, so nobody over-trusts it:** it bans **7 hex strings** across 3
files. `CrystalPanel.tsx` contains **66 hex literals (28 distinct)**, of which **exactly one** is a
banned string — and it sits inside the excluded range. `#4f46e5` (5×, including the **active
brand pill** at `:1321-1322`, a control whose entire job is to read as brand-selected and which
will not follow a customer's brand), `#dc2626` (5×), `#059669` (5×), `#eef2ff` (3×) and 20 others
sit untouched. Several are **semantic tokens re-hardcoded**: `#dfe3e6` is
`--color-surface-container-high`, `#b41340` is `--color-error`, `#d1fae5` is
`--color-success-container`, `#059669` is `--color-success`. **"We have a test-enforced token
cascade" is not a true statement and must not be used as an argument in either direction.**

### 5.5 Correct `app/CLAUDE.md:73` and `brandTheme.ts:9-10` — and the doctrine they created

Both assert (verbatim, `app/CLAUDE.md:73`):

> *"Tailwind utilities like `bg-primary` are baked at build time and will NOT update at runtime."*

**Measured false.** `.bg-primary{background-color:var(--color-primary)}` in the shipped bundle,
with the unlayered `:root` winning (§5.1). `brandTheme.ts:9-10` says the same thing in the module
header. `app/CLAUDE.md:74-80` then codifies the wrong doctrine into a ✅/❌ example block.

**This correction is a migration prerequisite, not documentation hygiene.** The entire styled-first
strategy depends on registry components' utility classes being brandable. If the file every agent
and engineer reads says they are not, the first reviewer to open a registry PR will reject it
correctly-per-the-docs and wrongly-per-reality. **~30 LOC across `app/CLAUDE.md` (the rule + the
example block + the Layer 3a/3b diagram at `:66-70`) and `brandTheme.ts:1-11`. G0.**

**And the doctrine has already cost real money.** Because "inline `style` or it won't brand" was
the rule, `CrystalPanel.tsx` carries **66 hex literals and 27 inline `color-mix(in srgb, …)`
expressions** where Tailwind utilities would have worked and would have been lintable. **The
doctrine produced the untokenised mess the token test then had to police.** Correcting it is worth
doing on its own merits.

### 5.6 `components.json` emits `.jsx` — 1 line, and it will waste a day if missed

`app/components.json:5` — **`"tsx": false`**.

That instructs the shadcn CLI (which `npx assistant-ui add` shells out to) to write **`.jsx`** files.
Into a `strict`-TypeScript app with `tsc --noEmit` in CI. Every registry item would land untyped,
and `npm run typecheck` would either ignore them or fail depending on `allowJs`.

**Set `"tsx": true`. One line. G0, before the first `add`.** This is exactly the class of defect
that turns "run the CLI, look at the result" into a half-day of confusion at the spike.

### 5.7 `brandTheme.ts` has no contrast guard, and its radius defaults disagree with CSS

- **No contrast validation.** I grepped `brandTheme.ts` for `contrast|luminance|wcag|a11y`: **none.** It writes 15 raw values onto `:root` unvalidated, and `--color-primary-foreground` / `--color-on-primary` are **fixed light values** (`#f2f1ff`) that do not respond to the luminance of the brand a customer picks. **A customer setting a light `primary` produces white-on-light everywhere `bg-primary` is used.** The styled set makes this *worse*, because it leans on solid `primary` **fills** for send/submit controls where Crystal currently uses a gradient with white text over a dark-by-default blue. **~60 LOC for a validator; G3** (it is a brand-system fix, not a migration blocker, but the migration increases exposure to it)
- **Radius defaults disagree.** `brandTheme.ts:41-43` declares `radius: '1rem'`, `radiusSm: '0.5rem'`, `radiusLg: '2rem'`; `theme.css:41-43` declares `0.75rem / 0.375rem / 1rem`. **Calling `applyBrandTheme()` or `resetBrandTheme()` with no argument silently changes the app's radius scale away from the CSS defaults.** ~3 LOC, G0 — and it matters more after §2.4 rule 2 points `--composer-radius` at `var(--radius-DEFAULT)`

### 5.8 Delete the dead chat code — 679 LOC, no decision required

Independently verified, zero importers **including zero test importers**:

| File | LOC |
|---|---|
| `app/src/components/IrisChat.tsx` | **316** |
| `app/src/pages/insights/ConversationView.tsx` | **363** |

**Delete at G0.** From a design-system standpoint `ConversationView.tsx` is an active liability: it
is a hardcoded design mock (fake NPS answer `:118-136`, hand-rolled bar chart `:139-164`) that a
future engineer will find and copy — **and it will look especially authoritative once generative-UI
charts are a funded goal.** Approve unconditionally.

---

## 6. The `XperiqCopilot` convergence plan

**Ruling unchanged: CONVERGE, two-step, and step 1 is not a merge.**

### 6.1 Why it cannot be deferred

| Choice | Effect on migration scope |
|---|---|
| **Converge first** (my ruling) | One chassis, one message model, one ⌘K owner. Nadia's ~+1,015 LOC stands as written |
| **Leave alone** | Scope **roughly doubles.** `XperiqCopilot` either gets its **own** `ExternalStoreRuntime` + `convertMessage` + custom parts — a second full adapter over a *different* message type (`ChatMessage`, `:53-60`) and a *non-streaming* transport (single REST `onRefine`) — or it permanently diverges, and Xperiq maintains a hand-built chat **and** a library-based chat with a ⌘K conflict resolved by a path regex (`AppShell.tsx:43`). **This is the worst outcome available and it is the default** |
| **Retire outright** | Not viable. It carries real builder-only product surface (`RefineResult.changes`, compliance risk, apply-recommendation). Deleting it deletes features |

### 6.2 It has *better* a11y than the flagship — carry that forward, don't lose it

| | `CrystalPanel.tsx` | `ExperientCopilot.tsx` |
|---|---|---|
| LOC | 2,799 | 616 |
| `aria-*` attributes | **1** (`:1765`) | **3** (`:282`, `:360`, `:601`) |
| Escape-to-close | **no** | **yes** (`:152`) |
| `t()` calls | 12 | **0** |
| In `CRYSTAL_IDENTITY_FILES` | yes (7 strings) | **no** |

**The "lesser" implementation has strictly better accessibility than the flagship.** Same repo,
same team, no library involved. **A framework does not fix a discipline gap. It relocates it, and
charges rent.** Concretely: §3.4's Escape-to-close is a **port of `:152`**, and §3.6's
`aria-label` sweep should start from `:360` / `:601`. **Convergence must be a two-way merge of
quality, not a replacement of the 616-LOC file by the 2,799-LOC one.**

### 6.3 The actual steps

**Step 1 — decouple the chassis, keep the product surface. ~1 day. Lands behind G1, before G2 opens.**

Of 616 LOC, ~180 is genuinely builder-specific (`RefineResult` / `Recommendation` /
compliance-risk / apply-recommendation UI, `:11-60` plus the recommendation cards). The other
~430 — message list, composer, autogrow, loading states, ⌘K, FAB, unread badge, mobile handling —
is a **duplicate** of `CrystalPanel`'s equivalent, worse except for Escape and the `aria-label`s.

1. **Port the good parts up first** (~15 LOC): Escape-to-close and the 3 `aria-label`s onto `CrystalPanel.tsx`. Do this *before* touching the copilot, so nothing is lost if step 1 stalls
2. **Fix the stale-rename a11y string** (`:282` `"Open Crystal — Experient Copilot"` → `t('crystal.openBuilder')`) and **add the file to `CRYSTAL_IDENTITY_FILES`** (§5.4) — ~3 LOC
3. **Route the builder through `openCrystal()` with `surface: 'builder'`.** The wire format **already supports this**: `CrystalPanel.tsx:355-377` sends `surface`, and `crystal.py:1776` uses it to **hard-force skill routing** (`CURRENT_STATE.md` #14). The context mechanism already exists — `contexts/crystalPanel.tsx:41,60-67` (`builderContext`, `builderDraft`, `builderDraftHydrator`) — and **the workflow builders converged onto the global panel this exact way** (`AppShell.tsx:44-49`). **The survey builder is the last holdout and the mechanism is already built and shipping**
4. **Re-render the ~180 LOC of builder-specific surface as Crystal `action_proposals`.** `RefineResult`/`Recommendation` map onto the existing 25-member `ActionProposalType` union + `onApplyRecommendation` → `executeAction`. **This is the only genuinely new work in step 1** and it must preserve the outcome funnel (`api.recordProposalOutcome`) — coordinate with Sam's funnel-integrity gate
5. **Remove the suppression:** `AppShell.tsx:43` (global panel suppressed on `/surveys/:id/build`), `:64-65` (⌘K not intercepted), `:101-103`. **This is the reversible switch** — restoring three conditions restores the old behaviour

**Step 2 — after convergence, `SurveyBuilderPage` is one more `openCrystal()` caller and there is one chat surface. Lands at G4** as part of cutover; `pages/SurveyBuilderPage.tsx:20,2415` drops the import, and `ExperientCopilot.tsx` is deleted.

**Gate assignment: step 1 behind G1, and G2 must not open until it is done.** If the pod starts G2
with two chassis, it is executing two migrations and costing one.

**Rollback:** step 1 is three conditions in `AppShell.tsx` plus one import in `SurveyBuilderPage.tsx`.
Keep `ExperientCopilot.tsx` on disk and unreferenced through G3; delete only at G4.

---

## 7. Cross-check with Nadia — one answer on styled vs headless

**We both recommended headless-only in the assessment. Both of our stated reasons are now measured
false. I am changing my answer; I am asking her to change hers.**

| Point | Nadia's position | Mine now | Evidence |
|---|---|---|---|
| Registry components use Tailwind brand utilities, which are build-time static, so *"every copied file needs a hand pass converting brand utilities to CSS-var inline styles"* (`ASSESSMENT_CRYSTAL_UI.md:312-314`) | headless-only | **Retract.** No hand pass needed | `.bg-primary{background-color:var(--color-primary)}` in the shipped bundle; `--color-primary` declared at depth 2 in `@layer theme` (`index.css:41`) and depth 1 unlayered (`theme.css:55`); **unlayered wins** |
| The styled set cannot carry Crystal's two-hue identity | (implied) | **Retract — this was mine, and it was my load-bearing objection** (`ASSESSMENT_XPERIQ_UI.md:137`) | `.text-tertiary`, `.from-primary`, `.to-tertiary`, `.bg-gradient-to-br` **all PRESENT in the bundle**; `--color-tertiary` has a live unlayered alias at `theme.css:78`; `ui/button.tsx:17` already ships `from-primary to-[var(--color-tertiary)]` |
| Registry copies fall outside `CRYSTAL_IDENTITY_FILES` and cannot fail the token test | agree (`:17`) | **Agree, confirmed.** `crystalIdentityTokens.test.ts:19-23` lists 3 files; copies land in `src/components/assistant-ui/` | — |
| The migration breaks the token test anyway via `[[1733, 1738]]` | agree (`:308`) | **Agree.** §5.3 — fix at G0, before anything reflows | `crystalIdentityTokens.test.ts:35-41` admits the fragility and records one prior re-point |
| *"Headless-only removes the last remaining reason to adopt at all"* | — | **This was mine (`ASSESSMENT_XPERIQ_UI.md:428`) and I withdraw it.** It was an argument against adopting; under a decided migration it inverts into an argument **for** the styled set. The styled set is where markdown, reasoning, tool-approval, suggestions and the tooltip button live — **and §1.2 measures all five as adoptable** | — |
| A11y: primitives commit to almost nothing | agree; ~110 LOC | **Agree, and it is unchanged by any of the above.** My number is ~191 (§3.6) because I add 4 measured contrast failures, `aria-pressed`, heading semantics, and `axe-core` in CI | `ThreadViewport.tsx` / `MessageRoot.tsx`: no ARIA in source; registry `thread.tsx`: `aria-live` 0, `role="log"` 0, `role="status"` 0 |
| `role="dialog"` would be wrong; non-modal panel | agree (`:347`) | **Strongly agree.** Formally ruled out, §3.5 | `CrystalPanel.tsx:1154-1164` no overlay; `AppShell.tsx:56-58` |
| Her `t()` count of 17 (`:19`) | 17 | **12.** Five substring false positives (`:233` `ge`+`t('`, `:398`/`:1037` `spli`+`t('`, `:653`/`:1108` `setInpu`+`t('`) | verified 12: `:939,1198,1204,1255,1391,1409,1421,1424,1429,1437,1442,1488` |
| `XperiqCopilot` must be decided first | agree (`:493`) | **Agree.** §6 — step 1 behind G1, G2 blocked on it | — |

### My position, stated for synthesis

> **STYLED-FIRST, at the message-part seam. Headless at the shell seam.**
>
> Adopt: `follow-up-suggestions`, `markdown-text`, `reasoning`, `tool-group`, `tool-fallback`,
> `tooltip-icon-button`, and `thread`'s Composer/ActionBar sub-trees.
> Compose headless: `ThreadPrimitive.Root` / `.Viewport` / `MessagePrimitive` under **our** panel
> shell.
> Hand-build: `sources` (citation data model), the panel chrome, the reasoning timeline's Crystal
> phase vocabulary, and `ActionProposalCard`'s expanded state.
> Defer pending product decision: `attachment`, `shiki-highlighter`, `thread-list`.
> Never: `assistant-modal`.
>
> **Backing evidence, in one line each:** 0 of 11 registry items fail on brand tokens; 5 theme with
> zero token edits; the 5 missing `--color-*` are a 6-line shim that **fixes two shipped bugs**
> (`ui/dropdown-menu.tsx:45`, `ui/button.tsx:14` at 2.00:1); `from-primary`/`to-tertiary` are
> already generated and live-brandable, so Crystal's identity is ~14 `className` edits; and copies
> are our files, so every string is `t()`-able on arrival.

**If Nadia still prefers headless-only, the disagreement is no longer about theming** — the theming
question is settled by measurement. It would be about **churn** (registry copies have no version and
no upgrade diff, §2.5), and that is a legitimate argument I would want Sam to arbitrate against his
dependency-churn runbook, not something I would relitigate on design-system grounds.

### Cross-check with Priya — two corrections and one strong endorsement

1. **Strike focus trap and `aria-modal`/`role="dialog"`** from `ASSESSMENT_CRYSTALOS.md` §6.2 item 3. Two of the five items she assigns me are **defects to add** (§3.5). Escape, focus restore and reduced motion I accept
2. **The reasoning timeline's i18n is fixable client-side today**, in one expression, against keys that already exist (§4.3). Not "otherwise unfixable." She *is* right about `observation.summary` (`crystal.py:1943-1947`) and the 6 error sentences — those are server prose on a display path, and §3.1 **suppresses `observation.summary` from the live region** until it carries a machine code
3. **`locale` on `CrystalInput` is the most important item in her document and I fully back it.** Model prose — `answer`, `suggestions[]`, and proposal `title`/`description`/`cta_label`/`business_rationale` (`crystal.py:166-172`) — **can never route through `t()`.** It has to be *generated* in the user's language. That makes `locale` the **only** true prerequisite for Xperiq ever shipping a second locale, and it is nearly free while the contract is already open. **If her G1 PR ships without `locale`, that is the single most expensive omission in the plan.** It also converts my WCAG 3.1.2 row from "not engaged" to "engaged and satisfiable"

---

## 8. Phased plan — G0 to G4

All estimates are **my lane only** (design system, a11y, i18n, platform hygiene, `XperiqCopilot`).
Nadia owns the adapter and custom parts; Priya the contract; Sam the flag, tests and churn runbook.
**Costs stated honestly per house rule 2 — including where I previously overstated them (§1.6).**

### G0 — Spike · **3 days** · +52 permanent / +~150 throwaway LOC

**Prerequisites:** none. Everything here is independently correct.

| Work | LOC | § |
|---|---|---|
| `components.json` `"tsx": true` | 1 | 5.6 |
| Token shim — 5 missing `--color-*` | 6 | 2.1 |
| Unlayer `--color-ring`, `--color-primary-foreground` | 2 | 2.2 |
| `@custom-variant dark` | 1 | 2.3 |
| `animate-collapsible-*` keyframes (option **c**) | 6 | 5.2 |
| `crystalIdentityTokens.test.ts` → content-match | 10 | 5.3 |
| Add `ExperientCopilot.tsx` to the guard + fix the stale `aria-label` | 3 | 5.4 |
| Correct `app/CLAUDE.md:66-80` + `brandTheme.ts:1-11` | 30 (docs) | 5.5 |
| `brandTheme.ts:41-43` radius defaults → match `theme.css:41-43` | 3 | 5.7 |
| `check:i18n` → `ci.yml` | 1 | 4.4 |
| Unlayered-`theme.css` invariant: comment + cascade test | 30 | 5.1 |
| Delete `IrisChat.tsx` + `ConversationView.tsx` | **−679** | 5.8 |
| Registry-hygiene guard test over `src/components/assistant-ui/**` | 40 | 2.4 |
| **Spike (throwaway):** `add` the 6 cleanly-theming items; render unmodified `CrystalThinkingBubble` + `ActionProposalCard` inside `ThreadPrimitive`; screenshot-diff at default brand + a light-primary brand + a dark-primary brand | ~150 | 1 |

**Gate exit:** the §1.2 table confirmed or corrected **by observation**; `bg-popover` and
`bg-secondary` verified fixed; the cascade test green; **the styled-vs-headless question closed with
a measurement** (this document is the prediction — G0 either confirms it or amends it).

**Rollback:** delete the spike branch. Every permanent item stands on its own merits and none of
them mentions assistant-ui.

**Risk this phase carries:** the composer looks *slightly* wrong at first paint — `oklab` tint,
1.5 rem pill radius, `dark:shadow-none` on an OS-dark reviewer's machine — and the pod concludes
"the styled set can't hold Crystal's look" from an artefact that is **3 lines of edit**. **Mitigation:
apply §2.4 rules 1–3 and §2.3 *before* anyone reviews screenshots.** This is the phase where a
cosmetic accident can overturn a correct decision.

### G1 — Contract + a11y on the current panel · **4 days** · +252 / −13 LOC

**Prerequisites:** G0. Priya's message-identity PR lands **in parallel**, not before — nothing here
depends on it.

| Work | LOC | § |
|---|---|---|
| `CrystalAnnouncer.tsx` — `role="log" aria-live="polite"`, wired to `answer` / `thinking` / `streamError`; `observation.summary` suppressed | 45 | 3.1 |
| Contrast fixes #1–3 (`:1494`, `:2498`, `:2506`) → 6.27:1 each | 3 | 3.2 |
| Contrast fix #4 (`:1465`) — **blocked on design sign-off** | 1 | 3.2 |
| `role="complementary"` + `aria-label` + real heading + `aria-labelledby` | 6 | 3.6 |
| Escape-to-close (port `ExperientCopilot.tsx:152`) | 10 | 3.4 |
| `focus-within` ring on the composer field wrapper | 4 | 3.6 |
| `TOOL_META` → `t('crystal.tool.' + tool)` | **1 expr**, −13 strings | 4.3 |
| `check-i18n.mjs` — defined-but-unused direction, warn-only | 15 | 4.4 |
| `crystal.ui.*` + `crystal.tool.approval.*` + `crystal.reasoning.*` locale keys, ahead of the components | ~40 | 4.2 |
| **`XperiqCopilot` step 1** (§6.3, incl. porting Escape + 3 `aria-label`s up first) | ~130 net | 6 |

**Gate exit:** `axe-core` violations on the **current** panel at zero for 1.3.1 / 4.1.3 / 2.4.3;
`check:i18n` green in CI with the unused-key warning visible; **one chat surface** —
`AppShell.tsx:43,64-65,101-103` suppression removed and the survey builder on the global panel.

**Rollback:** a11y items are additive and never rolled back. `XperiqCopilot` step 1 reverts by
restoring three conditions in `AppShell.tsx` and one import in `SurveyBuilderPage.tsx`;
`ExperientCopilot.tsx` stays on disk through G3.

**Risk:** **`XperiqCopilot` step 1 is the only item in my lane that touches shipping product
behaviour**, and step 4 (`RefineResult`/`Recommendation` → `action_proposals`) can regress the
proposal outcome funnel — which is **already unreliable** (`emitted` is never written to
`crystal_action_proposals`, so emit→accept conversion is unmeasurable, `CURRENT_STATE.md` §5).
**A funnel regression here is invisible by construction.** This must land against Sam's
funnel-integrity gate, not before it.

### G2 — Parity · **6 days** · +~620 vendored / −~380 hand-built LOC

**Prerequisites:** G0, G1, Nadia's `ExternalStoreRuntime` + `convertMessage`, Sam's flag.

| Work | LOC | § |
|---|---|---|
| Land `follow-up-suggestions`, `markdown-text`, `reasoning`, `tool-group`, `tool-fallback`, `tooltip-icon-button` through the §2.4 checklist | +~470 vendored | 1.2 |
| Land `thread`'s Composer sub-tree; **ActionBar deferred until Priya's IDs ship** | +~150 | 1.2 |
| Re-skin the 4 gradient surfaces via `from-primary to-tertiary` | ~14 | 1.5 |
| `aria-label` on ~14 of 19 controls, via `TooltipIconButton` | 14 | 3.6 |
| `aria-pressed` on 4 window pills + Pin | 8 | 3.6 |
| Focus restoration — one additive context member, **zero call sites touched** | 25 | 3.4 |
| `prefers-reduced-motion` gate + global reduce block | 30 | 3.3 |
| `axe-core` assertion in CI over the panel, both flag states | 25 | 3.6 |
| `check-i18n.mjs` hardcoded-string heuristic, allowlisted to the 2 migration dirs | 60 | 4.4 |
| Delete the hand-built markdown-less `CitedText` prose path (**keep citation resolution**) | −~380 | — |

**Gate exit:** every current Crystal capability works on the new chassis behind the flag; `axe-core`
clean in **both** flag states; the registry-hygiene guard green; zero regression in the proposal
outcome funnel (Sam's).

**Rollback:** the flag. Registry files stay on disk unreferenced; a11y and i18n work is on both
paths by design (§3.0).

**Risk:** **`tailwind-merge` order-dependence.** Crystal-identity overrides applied via `className`
on registry parts can silently lose to the component's own classes depending on `cn()` argument
order — and the failure mode is a *subtly off* colour, not an error. Nothing in CI detects it.
**Mitigation: edit copies in place (§2) rather than overriding from outside — this risk is the
single strongest reason the strategy is "edit in place" and not "wrap."** Secondary risk: the
citation retro-enrichment path (`:423-431`) must survive `convertMessage`; that is Nadia's seam but
it renders through *my* `InlineCitation`, so we own it jointly.

### G3 — Gains · **5 days** · +~300 LOC · **ordering needs a product decision**

**Prerequisites:** G2. Priya's thread-persistence ruling for `thread-list`.

| Work | LOC | § |
|---|---|---|
| `thread-list` after 4 token edits (+ `skeleton`) — **blocked on the persistence ruling** | +~180 | 1.2 |
| Generative-UI chart components (Recharts, already in `app/package.json`) themed to the token layer, `aria-hidden` on decorative SVG, accessible summaries | ~80 | — |
| `InlineCitation` tooltip: Escape-dismiss + `aria-describedby`, **or** replace with `ui/tooltip.tsx` (Radix, already a dependency) | 20 | 3.6 |
| Contrast validator in `applyBrandTheme()` | 60 | 5.7 |
| Revisit `tw-animate-css` (option **a**) with a designer | 10 | 5.2 |
| `thread`'s ActionBar (copy/regenerate) — **only if Priya's IDs shipped at G1** | +~60 | 1.2 |

**Gate exit:** markdown, `aria-live`, persistence and charts live; the brand contrast validator
rejects at least one real customer brand (if it rejects none, the validator is wrong — that was one
of my four "what would change my mind" tests and it is worth keeping as a check on ourselves).

**Rollback:** per-feature, all behind the same flag.

**Risk:** **the two abandoned precedents.** `MiniNPSChart` was **deliberately removed**
(`CrystalPanel.tsx:2543`) while Recharts was already available, and `render_hint: 'document'` exists
in CrystalOS tool results with `InsightDocumentCard` wired to render it but **no server emitter ever
ships it.** Two abandoned attempts at rich content in Crystal messages is a **pattern**. If the
cause was product judgment rather than engineering difficulty, a library will not change the
outcome, and we will have themed chart components nobody emits into.

> **NEEDS A PRODUCT DECISION — flagged, not defaulted.** There is **no PM and no user research on
> this pod** (`TEAM.md` §Coordination). G3's internal ordering — markdown vs. persistence vs. charts
> vs. the a11y remainder — is currently an engineering guess. My lane's guess, stated so it can be
> overruled: **markdown first** (it is the gap users hit on literally every response —
> `**bold**`, lists and tables render as literal characters today), **a11y second** (it is a legal
> and moral floor), **charts third** (they need the abandoned-precedent question answered first),
> **persistence last** (it needs Priya to collapse three implementations and two disagreeing
> schemas). **I do not have the standing to make that call and I am not making it.**

### G4 — Cutover · **3 days** · −~1,450 LOC

**Prerequisites:** G3, Sam's funnel-integrity sign-off, one full release cycle at G3 with the flag on
for internal users.

| Work | LOC |
|---|---|
| Flag defaulted on; remove the flag branches | −~40 |
| Delete the old hand-built panel internals | −~1,400 |
| **`XperiqCopilot` step 2** — delete `ExperientCopilot.tsx`; `SurveyBuilderPage.tsx:20,2415` drops the import | −616 |
| Ratchet the hardcoded-string heuristic from warn to error on the 2 migration dirs | 2 |

**Gate exit:** one chat surface; one chassis; `check:i18n` and `axe-core` both **blocking** in CI on
the Crystal directories.

**Rollback:** **this is the phase where rollback stops being cheap.** Once the old internals are
deleted, reverting means a git revert of a large deletion commit, not a flag flip. **Do not enter G4
until G3 has been flag-on in production for a full release cycle** — that is the whole reason the
prerequisite is worded that way.

**Risk:** the deletion takes something unnoticed with it. Crystal's **streaming, citations, thinking
timeline, error states and voice are untested** — grepping the CrystalPanel test files for
`citation_context`, `CitedText`, `SourcesFooter`, `ThinkingBubble`, `EmptyState`,
`SpeechRecognition`, `verbatim` returns **zero hits** across ~1,958 LOC of tests. **Sam's
characterisation tests must be written before G2, not before G4** — by G4 there is nothing left to
characterise.

### Totals — my lane

| | Days | Permanent LOC |
|---|---|---|
| G0 | 3 | +133 / −679 |
| G1 | 4 | +252 / −13 |
| G2 | 6 | +620 / −380 |
| G3 | 5 | +300 |
| G4 | 3 | −2,056 |
| **Total** | **21 working days** | **net ≈ −1,823** |

**21 days is ~4 working weeks for one engineer on the platform lane alone**, and it excludes Nadia's
adapter, Priya's contract and Sam's harness. **That is the honest number.** Roughly 8 of those 21
days (G0 entirely, plus the a11y and i18n work in G1–G2) are **work we owe regardless of the
migration** and which survives any rollback — which is the strongest thing I can say about this
sequence: **it front-loads the parts that cannot be wasted.**

---

## 9. Items needing a product decision — flagged, not defaulted

| # | Decision | Why I will not default it | Gate it blocks |
|---|---|---|---|
| 1 | **Composer field border** (§3.2 #4): lose the brand tint for `--color-outline` at 4.51:1, or keep it and go visually heavier at ≥65% mix | A visible change to the most-looked-at control in Crystal | G1 |
| 2 | **`tw-animate-css`** (§5.2): installing it makes **six existing shared components animate for the first time**, platform-wide | Not an engineering decision. Fixes a real defect; changes the feel of every menu, dialog, sheet, tooltip and select | G3 |
| 3 | **The `text-[10px]` type scale** (32 + 4 occurrences): it is the *root cause* of three of the four measured contrast failures — tiny type compensated with low-contrast greys | Fixing it is a visual redesign of the panel, not an a11y patch | G3 |
| 4 | **`attachment`** (§1.2): file upload is a **new feature**, not migration parity. Costs `avatar`, `skeleton`, `zustand`, and 8 strings | Scope, not engineering | post-G4 |
| 5 | **`shiki-highlighter`** (§1.2): does Crystal ever emit code? No emitter produces it today. Ships non-brand GitHub themes | Same | post-G4 |
| 6 | **G3 internal ordering** (§G3): markdown vs a11y vs charts vs persistence | **No PM and no user research on this pod.** My guess is stated and should be overruled by anyone with data | G3 |
| 7 | **Dark mode**: §2.3 makes `dark:` inert, which is right *today*. Whether Xperiq ever ships a `.dark` theme is a roadmap question — and the answer determines whether ~40 `dark:*` classes in registry copies are dead weight or latent value | Roadmap | post-G4 |
| 8 | **The abandoned-precedent question** (§G3 risk): `MiniNPSChart` removed with Recharts available; `render_hint:'document'` wired with no emitter. **Was the cause product judgment or engineering difficulty?** | If it was judgment, generative UI will be abandoned a third time and G3's chart work is waste. **Somebody must answer this before G3 is funded** | G3 |

---

## 10. Would I approve this dependency in a design-system review?

**Yes, now, at the message-part seam, with the §2.4 checklist test and the §4.4 i18n gate as
merge-blocking conditions.**

My assessment said **no** on three grounds. Here is what happened to each:

1. *"It does not deliver the capability it is being bought for"* — **this one still stands, and it must stay on the record.** assistant-ui delivers ~1.5 of 14 a11y defects and **0% of WCAG 4.1.3**. §1.6(d) re-verified it. **A11y is ours to build, ~191 LOC, and §3 is that build plan.** The difference is that a11y is no longer the *purchase rationale* — the charter's rationale is generative UI and standard conversational infrastructure (`README.md:14`), which are real things the library does deliver. **A dependency that fails to deliver capability A is not disqualified if it was bought for capability B — provided nobody pretends A came free. This document is the record that A did not.**
2. *"The only layer that survives design-system scrutiny is the layer with no value"* — **withdrawn, and it was wrong by measurement.** The styled set survives scrutiny: 0 of 11 items fail on brand tokens, 5 theme with zero token edits, and the value (markdown, reasoning, tool-approval, suggestions, tooltip button) is in exactly that layer. My own §1.3 objections — the literal radius, the `oklab` split, the missing second brand hue — cost **~14 `className` edits and 6 lines of shim**, not a full restyle. I over-indexed on theming risk, which is the failure mode I predicted for myself (`ASSESSMENT_XPERIQ_UI.md:506`).
3. *"We would be buying a dependency to substitute for governance we have not installed"* — **the objection was right and the plan answers it.** `check:i18n` in CI (§4.4 #1, **1 line**), the reverse-direction check (#2), the hardcoded-string heuristic (#4), `axe-core` in CI (§3.6), the registry-hygiene guard (§2.4), a content-matched token guard covering all four Crystal-identity files (§5.3–5.4), and the first cascade-evaluating test in the repo (§5.1). **All of it lands at G0–G2, i.e. before and alongside the components, not after.** Buying the library and installing the gate are not alternatives, and framing them as alternatives was the weakest part of my assessment.

**The condition I will not drop:** §5.5. If `app/CLAUDE.md:73` still says Tailwind utilities are not
live-brandable when the first registry PR opens, a reviewer will reject correct code by following
the documentation. **Correcting that file is a prerequisite for G0, not documentation hygiene** —
it is the one line of prose the entire styled-first strategy rests on.

---

## Appendix — new measurements, reproducible

**Registry payloads fetched 2026-08-04** from `https://r.assistant-ui.com/<name>.json`:
`thread`, `styles/default/thread`, `markdown-text`, `reasoning`, `tool-fallback`, `tool-group`,
`tooltip-icon-button`, `follow-up-suggestions`, `thread-list`, `attachment`, `sources`,
`shiki-highlighter` (`syntax-highlighting` → **404**; `ASSISTANT_UI.md:38` should be corrected).

**Registry URL pattern** (`/docs/cli.md`): `https://r.assistant-ui.com/styles/{style}/{name}.json`,
`{style}` from `components.json`; **`base-`-prefixed styles resolve to Base UI, all others to
Radix.** `app/components.json:4` is `"default"` → Radix. Legacy fallback
`https://r.assistant-ui.com/{name}.json`.

**Bundle measurement** — `app/dist/assets/index-YOCsYUQe.css`, 164,168 bytes, built 2026-07-14:

| Probe | Result |
|---|---|
| `.bg-primary` | `background-color:var(--color-primary)` |
| `.bg-secondary` | `background-color:var(--color-secondary)` |
| `.text-tertiary` / `.from-primary` / `.to-tertiary` / `.bg-gradient-to-br` | **PRESENT** |
| `.bg-popover` / `.text-popover-foreground` | **ABSENT** (used at `ui/dropdown-menu.tsx:45`) |
| `.text-secondary-foreground` | **ABSENT** (used at `ui/button.tsx:14`) |
| `.animate-in` / `.animate-out` / `.fade-in-0` / `.zoom-in-95` / `.slide-in-from-top-2` | **ABSENT** (used in 6 `ui/` files) |
| `--color-popover` / `--color-popover-foreground` / `--color-card-foreground` / `--color-input` / `--color-secondary-foreground` | **0 declarations** |
| `--animate-*` | **0** |
| `prefers-reduced-motion` | **0** |
| `prefers-color-scheme` | **1** — `@media (prefers-color-scheme:dark){.dark\:text-amber-400{…}}` |
| `.dark` selector | **0** |
| `--color-tertiary:` | **2** (layered `#8329c8` + unlayered `var(--brand-accent)`) |

**Unlayered-alias audit** (`^  --color-X:` in `index.css` @theme vs `theme.css` unlayered `:root`):

```
primary, secondary, tertiary, on-primary, background   → declared in BOTH  → LIVE
muted, muted-foreground, accent, border, card,
  foreground, destructive                              → index.css only    → FROZEN (correct: neutral)
ring (#2a4bd9), primary-foreground (#f2f1ff)           → index.css only    → FROZEN-WRONG
popover, popover-foreground, card-foreground,
  input, secondary-foreground                          → nowhere           → MISSING
```

**Contrast computations** (WCAG 2.x relative luminance, over `#ffffff`):
`#00647c` bg / `#2c2f31` text → **2.00:1**; `#595c5e` at 50% alpha → **2.24:1**, at full →
**6.27:1**; `--color-outline` `#747779` → **4.51:1**; `--color-primary` `#2a4bd9` → **6.76:1**;
`color-mix(in srgb, var(--color-primary) X%, transparent)` over white → 14% = **1.23:1**,
60% = 2.90:1, 65% ≈ 3.2:1, 70% = **3.58:1**.

**Repo facts newly verified for this plan:** `app/components.json:5` `"tsx": false`;
`.github/workflows/ci.yml:38,44,47` runs lint / test:coverage / build:app only;
`app/scripts/check-i18n.mjs:37,46-50` reports used-but-undefined keys only;
`app/src/components/ui/` has **no `avatar`, no `skeleton`**; `ui/collapsible.tsx` is Radix
(`@radix-ui/react-collapsible@1.1.15`) ✓; `crystalIdentityTokens.test.ts:19-23` lists **3** files
and `:43` excludes `[[1733, 1738]]`; `en.ts:3947-3959` defines **13** `crystal.tool.*` keys matching
`CrystalPanel.tsx:2193-2205`'s **13** `TOOL_META` entries key-for-key, with different wording;
`ExperientCopilot.tsx:152` has Escape-to-close and `:282,360,601` three `aria-label`s.
