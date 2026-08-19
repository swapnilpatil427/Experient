# RESULT — Minimal assistant-ui adoption (Marcus, Frontend)

Implemented, verified green (`tsc`/`lint`/`vitest`), see final summary for file paths.
This note is the honest engineering account BRIEF.md asked for.

## What assistant-ui gave for free

- **The propose→confirm→execute UI primitives for chat itself** — `ThreadPrimitive`,
  `ComposerPrimitive`, `MessagePrimitive`, `ThreadListPrimitive`,
  `ThreadListItemPrimitive` — cover viewport auto-scroll, composer submit-on-Enter
  (with Shift+Enter newline), disabled/running states on the composer while a
  turn is in flight, per-item thread switch/rename-hook-point/archive/unarchive/
  delete actions, and an empty-thread state — all wired to a state shape I own,
  with zero hand-rolled scroll-to-bottom or keyboard-submit logic. That's real:
  `CrystalPanel.tsx`'s current chat area hand-rolls a manual `scrollTop` effect
  and its own Enter-to-send handling; this spike needed none of that.
- **Markdown rendering "for free."** `@assistant-ui/react-markdown`'s
  `MarkdownTextPrimitive` is a drop-in `Text` part-slot (it reads the message
  text from context via `useMessagePartText()` — no plumbing needed beyond
  `<MessagePrimitive.Content components={{ Text: CrystalAssistantText }} />`).
  This closes a documented real gap: the existing `CrystalPanel.tsx` renders
  answers through `CitedText`, which emits plain `<span>`s — `**bold**`, lists,
  and tables show as literal characters today. Two lines of wiring fixed that
  for this surface.
- **The external-store/thread-list contract shape is genuinely well-designed**
  once you're on the right runtime (see below): `ExternalStoreThreadListAdapter`
  is a small, obvious interface (`threads`, `archivedThreads`, `onSwitchToThread`,
  `onRename`, `onArchive`, `onDelete`, …) that maps cleanly onto "an array of
  `{id, title, status}` in localStorage" with almost no impedance mismatch.

## What I had to hand-build

- **The entire visual layer.** There is no npm-published "default styled"
  Thread/ThreadList/Composer — assistant-ui distributes those via a
  shadcn-style CLI (`npx shadcn add @assistant-ui/thread`) that fetches JSX
  source from `r.assistant-ui.com` at install time, copy-paste-owned into the
  repo (same model as this codebase's own shadcn/UI components). That
  registry host was **unreachable from this sandbox's network policy**
  (only an internal artifactory/gitlab allowlist; `r.assistant-ui.com` isn't
  on it), so I could not run the CLI and could not use `WebFetch` to recover
  the real source either — `WebFetch` summarizes fetched pages through a
  small model rather than returning raw text, and asking it to "reproduce
  the JSON verbatim" for a ~900-line registry file produced a prose summary,
  not usable code. So `CrystalThread.tsx` / `CrystalThreadList.tsx` are
  hand-composed directly from the npm-published (reachable) `@assistant-ui/react`
  **primitives** — correct and using 100% of the library's actual chat/thread
  logic, but not the maintainers' visual design. This is a real, sandbox-
  specific friction point, not a library shortcoming — a normal dev machine
  with open network access would have hit none of this.
- **Rename.** There's no `ThreadListItemPrimitive.Rename` (only
  `Trigger`/`Title`/`Archive`/`Unarchive`/`Delete`). Built a small inline
  text-input toggle that calls `store.renameThread(id, title)` directly —
  correct, but "rename a thread" is table-stakes chat-app functionality with
  zero primitive support.
- **Every bit of brand theming.** By design (BRIEF.md), but worth naming:
  every color in the two new components is `var(--color-*)`, none of it comes
  from the library.
- **All persistence.** `useCrystalThreadStore` + `lib/crystalAssistantUiStore.ts`
  (localStorage load/save/CRUD) is ~180 lines of code assistant-ui contributes
  nothing to — the adapter interface is the only thing it defines; the store
  behind it is 100% this codebase's.

## Real friction / API-instability encountered

1. **BRIEF.md's own starting-point sketch doesn't compile against the
   installed version.** The brief suggested `useLocalRuntime` +
   `ExternalStoreThreadListAdapter`. Per the actual installed package
   (`0.15.15`, verified by reading
   `node_modules/@assistant-ui/core/dist/runtimes/external-store/external-store-adapter.d.ts`
   directly rather than trusting prose docs): `adapters.threadList` only
   exists on `ExternalStoreAdapterBase`, i.e. only `useExternalStoreRuntime`
   accepts a thread-list adapter. `useLocalRuntime`'s own docs page states
   multi-thread support comes only via "AssistantCloud or a custom
   `RemoteThreadListAdapter`" — both out of scope here (cloud = the
   third-party data flow BRIEF.md explicitly forbids; `RemoteThreadListAdapter`
   implies a backend endpoint, also forbidden this pass). I used
   `useExternalStoreRuntime` instead — the supported pairing, no lost
   functionality, but it means the brief's own "technical shape" section was
   wrong about which two hooks compose, and I only found out by reading the
   installed `.d.ts` files, not the hosted docs.
2. **The hosted docs and the installed types disagree, concretely.**
   `WebFetch`ing `https://www.assistant-ui.com/docs/runtimes/concepts/threads`
   summarized `ExternalStoreThreadListAdapter`'s `threads` field as
   `{ threadId, title }[]`. The actual installed type
   (`ExternalStoreThreadData<"regular">`) is `{ status, id, remoteId?,
   externalId?, title?, custom? }[]` — different field name for the id
   (`id`, not `threadId`) and a required `status` discriminant the docs
   didn't mention at all. Had I written code against the docs' paraphrase
   without cross-checking the real `.d.ts`, it would not have compiled.
3. **The exact API BRIEF.md asked me to use is itself marked unstable in the
   installed version.** In `external-store-adapter.d.ts`, `threadId`,
   `onSwitchToNewThread`, and `onSwitchToThread` on
   `ExternalStoreThreadListAdapter` all carry `@deprecated This API is still
   under active development and might change without notice.` These are not
   edge-case fields — they're the three that make thread-switching work at
   all. This directly corroborates the prior effort's `FINDINGS.md` concern
   about `unstable_`-surface churn risk, just under a different label
   (`@deprecated` rather than an `unstable_` prefix) in this version.
4. **`ThreadPrimitive.Empty` / `ThreadPrimitive.If` are deprecated in favor of
   `AuiIf`, which the `@assistant-ui/react` wrapper package doesn't re-export**
   (only the undeclared transitive dependency `@assistant-ui/core` does). Used
   the still-functional deprecated primitive rather than importing from a
   package not in `package.json`.
5. **Getting-started/installation URLs guessed from convention 404'd**
   (`/docs/getting-started/quickstart`, `/docs/runtimes/local/use-local-runtime`,
   `/docs/runtimes/custom/local`) — had to discover the real paths
   (`/docs/installation`, `/docs/runtimes/custom/local-runtime`,
   `/docs/runtimes/custom/external-store`) by asking the pick-a-runtime page
   to list its own outbound links. Minor, but it's more of this same theme:
   the docs site's own internal link structure isn't stable/guessable either.

## Honest opinion: worth pursuing further?

**Qualified yes for the thread-list/persistence piece specifically; no
change to the prior pod's verdict on a full chat-UI migration.**

This pass delivered the one thing `FINDINGS.md`'s three-specialist review
said was the actual point — real multi-thread history that survives a
refresh — in about half a day of implementation, with the chat-model wiring
being the easy, boring part (one `fetch`-shaped adapter around the existing
`crystalChat2` call, no CrystalOS/backend touch). That's a genuine, visible
upgrade Crystal has never had, and it cost far less than `FINDINGS.md`'s
migration-LOC estimates because this pass explicitly didn't try to replace
`CrystalPanel.tsx`'s bespoke citation/action-proposal/streaming-timeline UI —
the parts `FINDINGS.md` correctly identified as "hand-build regardless."

But three things from this pass reinforce rather than overturn the prior
verdict:

- **The exact fields needed to make thread switching work
  (`threadId`/`onSwitchToNewThread`/`onSwitchToThread`) are marked
  `@deprecated`/unstable in the version installed today.** Building on them
  now means accepting a real chance of a breaking change on the next minor
  bump — the same churn-tax finding as before, now demonstrated concretely
  against the piece this pass actually shipped, not a hypothetical.
- **The "default styled" components are not really an npm dependency at
  all** — they're a one-time code-generation step (shadcn-style CLI) that
  requires network access to a third-party host at install time. That's a
  meaningfully different adoption shape than "add a package," and it failed
  outright in this environment. A production adoption needs to budget for
  either vendoring that generated code once (accepting it will drift from
  upstream) or accepting network dependency on `r.assistant-ui.com` in every
  dev/CI environment forever.
- **Docs-vs-installed-types drift is not hypothetical friction — it happened
  twice in one afternoon** (BRIEF.md's own suggested hook pairing, and the
  `ExternalStoreThreadListAdapter` field shape). Anyone extending this surface
  later should read `node_modules/@assistant-ui/*/dist/**/*.d.ts` directly
  before trusting the hosted docs, every time — that's a standing tax on
  every future change, not a one-time cost.

**Recommendation:** keep this spike's localStorage thread-list pattern in mind
as the shape of a real future "Crystal remembers your conversations" feature,
but land it as a genuinely separate, small project — swap the adapter for a
backend-owned one against `crystal_threads` v2 (per `ASSESSMENT_CRYSTALOS.md`'s
turn-id contract work, which is worth doing regardless) — rather than treating
this as a first step toward migrating `CrystalPanel.tsx`'s existing chat UI.
That larger migration question is unchanged from the prior pod's `DON'T`.
