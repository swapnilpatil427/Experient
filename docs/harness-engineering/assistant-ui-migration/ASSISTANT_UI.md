# assistant-ui — What It Actually Is

> **Sources:** the project's own GitHub repo, its published docs sitemap (`/llms.txt`), and individual doc pages fetched 2026-08-04.
> **Provenance warning:** an initial automated fetch of the marketing homepage returned a summary asserting assistant-ui is "Anthropic's official library." **That is false** — it was a summarizer artifact. assistant-ui has no affiliation with Anthropic. Every claim below is sourced from the repo or a specific doc page, and anything unverified is marked as such.

---

## 1. Project facts

| | |
|---|---|
| **Description (verbatim)** | "The UX of ChatGPT in your React app 💬🚀" |
| **License** | MIT |
| **Stars** | ~11.4k |
| **Backing** | Y Combinator; maintainer Simon Farshid |
| **Commercial layer** | "Assistant Cloud" — managed thread persistence, telemetry, file storage |
| **React support** | React 18 and 19. React 16/17 unsupported. No Next.js dependency; no RSC requirement |
| **Version** | Pre-1.0 (`0.x`) |

**Published packages:** `@assistant-ui/react` plus integration packages for AI SDK, LangGraph, LangChain, AG-UI, A2A, Google ADK, OpenCode, data-stream, React Native, and Ink (terminal).

### Churn signal

Dedicated breaking-change migration guides exist for **v0.11, v0.12, v0.14, and v0.15** — including `ContentPart → MessagePart` (v0.11), a "unified state API" (v0.12), and "hook and key removal" (v0.15). Additionally, the stability policy states that `unstable_`-prefixed APIs may change in **"any release including patch releases."**

This matters because several of the arguments-in-favour below depend on `unstable_`-prefixed surface (see §3).

---

## 2. What it provides

Three layers, adoptable independently:

**Primitives (headless).** Self-described as "unstyled, accessible Radix-style building blocks": `Thread`, `Composer`, `Message`, `MessagePart`, `ActionBar`, `BranchPicker`, `ChainOfThought`, `Attachment`, `Error`, `Suggestion`, `SelectionToolbar`, `ThreadList`, `AssistantModal`.

**Runtimes.** Protocol adapters. Four patterns for a custom backend (see §3).

**Styled components.** A large set — and notably, it covers most of Crystal's current gap list: `markdown`, `syntax-highlighting`, `reasoning` (collapsible thinking), `sources`, `mermaid`, `image`, `file`, `quote`, `tool-fallback`, `tool-group`, `part-grouping`, `message-timing`, `follow-up-suggestions`, `context-display`, `diff-viewer`, `model-selector`, `voice`, `assistant-sidebar`, `thread-list`.

**Guides exist for exactly what Crystal lacks:** chain-of-thought, attachments, branching, editing, virtualization, dictation, speech (TTS), suggestions, slash commands, mentions, LaTeX, RTL, resumable streams.

---

## 3. The four custom-runtime patterns

This is the actual decision surface.

| Pattern | You write | Fit for Crystal |
|---|---|---|
| **LocalRuntime** (`useLocalRuntime` + `ChatModelAdapter`) | A `run()` function | Plausible. "Quickest path to a working chat" |
| **DataStream** | Nothing — backend emits their standardized message-part stream | Poor. Would require rewriting the CrystalOS/Express SSE format to their protocol |
| **AssistantTransport** | Backend streams full agent-state snapshots | Poor. Crystal streams phase events, not state snapshots |
| **ExternalStoreRuntime** (`useExternalStoreRuntime`) | Your own state + a `convertMessage` function | **Best fit.** "You own the state, the adapter translates" |

### The `ChatModelAdapter` finding that kills a common objection

```
run: ChatModelRunOptions => ChatModelRunResult | AsyncGenerator<ChatModelRunResult>
```

`run()` receives `{ messages, runConfig, abortSignal, context, unstable_assistantMessageId?, unstable_threadId?, unstable_parentId?, unstable_getMessage? }` and returns `{ content: [{ type: "text", text: "..." }] }`.

**The generator form is optional, and yields are cumulative full state — explicitly "not deltas."**

So: **"Crystal doesn't stream tokens, therefore assistant-ui won't work" is wrong.** A single-shot `answer` frame is a legal, first-class return value. This was the assumed blocker and it does not exist.

Note, however, that thread and parent identity arrive as `unstable_`-prefixed options — i.e. on the surface the stability policy says can change in a patch release.

### ExternalStoreRuntime shape

```typescript
const convertMessage = (message: MyMessage): ThreadMessageLike => ({
  role: message.role,
  content: [{ type: "text", text: message.content }],
  id: message.id,
  createdAt: new Date(message.timestamp),
});

const runtime = useExternalStoreRuntime({
  messages, isRunning, setMessages, onNew: async (message) => { /* ... */ },
});
```

Features are **capability-gated by which handlers you supply**:

| Handler | Unlocks |
|---|---|
| `onNew` | sending (required) |
| `setMessages` | branch switching |
| `onEdit` | edit button |
| `onReload` | regenerate button |
| `onCancel` | cancel button |

Constraint: all handlers must be immutable — "mutation causes state update failures."

**Crystal's `messages` array (`CrystalPanel.tsx:196`) could be adapted without being rewritten.** But note the capability gating interacts badly with wire-format finding #6 in `CURRENT_STATE.md`: `onEdit` and `onReload` are only implementable if messages have stable server-side identity, which Crystal's contract does not provide.

---

## 4. Tool UI — the strongest argument in favour

Tool rendering is registered on toolkit entries via a `render` field:

```typescript
const WeatherToolUI: ToolCallMessagePartComponent<WeatherArgs, WeatherResult> =
  ({ args, status, result }) => { /* arbitrary React */ };

const toolkit = defineToolkit({
  getWeather: { type: "backend", render: WeatherToolUI },
});
```

Props received:

```typescript
type ToolCallMessagePartProps<TArgs, TResult> = {
  args: TArgs;
  argsText: string;
  status: ToolCallMessagePartStatus;   // running | requires-action | incomplete | complete
  isError?: boolean;
  result?: TResult;
  toolName: string;
  toolCallId: string;
  addResult: (result: TResult) => void;   // user-input completion
  resume: (payload: unknown) => void;
  interrupt?: { type: "human"; payload: unknown };
  artifact?: unknown;
};
```

There is also a first-class `type: "human"` toolkit entry for tools whose entire purpose is to ask the user something, with `addResult` as the completion callback, and `useInlineRender` for components needing parent props.

**Why this matters:** `{ args, status, result, addResult }` + a `requires-action` status + a `human` tool type is structurally the same shape as Crystal's `ActionProposal` → confirm-card → `executeAction` → `recordProposalOutcome` loop. That is not naming coincidence; it is the same human-in-the-loop pattern, and it is the one place where the library models something Crystal actually does.

**Caveat:** Crystal's proposals are emitted *out-of-band alongside a finished answer* (`CURRENT_STATE.md` finding #10), not as model-chosen tool calls mid-turn. Mapping them onto tool-call message parts means either synthesizing fake tool calls client-side, or changing CrystalOS to emit proposals as real tool calls — a three-layer change.

### What it does *not* model

- Crystal's `thinking`/`observation`/`synthesizing` phase vocabulary. `ChainOfThought` and the `reasoning` component exist, but they are built for model reasoning and model tool calls — not pre-fetch context tools with no args and no results.
- Inline `[uuid]` citation markers resolved against an out-of-band map delivered by a *different service*. A `sources` component exists, but for URL sources.
- Two different citation display strategies selected by scope.
- Per-turn client-uploaded grounding corpora (`insights[]`, `topics[]`, `metrics{}`).
- `surface`-based hard skill routing.

---

## 5. Adjacent capabilities worth noting

- **Custom persistence** via `RemoteThreadListAdapter` — thread list backed by your own Postgres rather than Assistant Cloud. This is the escape hatch from the commercial upsell.
- **Resumable streams** with Postgres/Durable Object backends — persist an in-flight response server-side.
- **Auth integrations** including Clerk, which Xperiq already uses.
- **Devtools** for inspecting runtime state.
- **`react-native` and `ink` packages** — irrelevant now, but they indicate the runtime abstraction is genuinely decoupled from DOM rendering.
- **A CLI** for scaffolding.

---

## 6. Honest summary of the fit

**Arguments for**
1. Closes Crystal's entire table-stakes gap list off the shelf: markdown, syntax highlighting, a11y-oriented primitives, thread list, attachments, TTS, virtualization, suggestions.
2. Tool UI is a real structural match for the proposal loop (§4).
3. The assumed blocker — no token streaming — is not a blocker (§3).
4. `ExternalStoreRuntime` means Crystal's state does not need rewriting to start.
5. MIT, no Anthropic/vendor lock at the library layer, and `RemoteThreadListAdapter` avoids the Cloud upsell.

**Arguments against**
1. Pre-1.0 with four breaking migrations in recent history, on what would become Xperiq's most important UI surface.
2. Thread/parent identity — needed for exactly the free features that motivate adoption — sits behind `unstable_` APIs that may change in patch releases.
3. The features that most justify adoption (edit / regenerate / branch) are **blocked by Crystal's own wire format**, not by the absence of a library. Adopting assistant-ui does not unblock them.
4. Everything differentiated (~1,450 LOC: reasoning timeline, citation layer, proposal loop) must be **rebuilt as custom parts**, not inherited — against a moving API.
5. ~~The styled component set collides with a test-enforced brand token cascade (`crystalIdentityTokens.test.ts`).~~
   **CORRECTED 2026-08-04 (Nadia, `ASSESSMENT_CRYSTAL_UI.md`):** this was wrong. assistant-ui's styled components are **CLI registry-copied into your repo** (the shadcn model), so they land outside the three paths `crystalIdentityTokens.test.ts:19-23` scans and *cannot* fail that test. The real objection is different and still stands: the copied components use Tailwind brand utilities rather than the mandated `var(--color-primary)` / `color-mix()` cascade — which argues for **headless primitives only**, not for rejecting the library on token grounds.
   *Separate live hazard found while checking this:* that test's hardcoded line-range exclusion `[[1733, 1738]]` false-positives on any reflow of `CrystalPanel.tsx` — including the monolith split we'd want to do anyway. Its own comment admits the fragility. ~10 LOC to fix; worth doing now regardless of this decision.
6. Library components ship hardcoded English. (Weak objection: Crystal is already ~95% hardcoded English despite the project rule — this relocates existing debt rather than creating new debt.)
7. Crystal is not a chat app. It is a copilot embedded in a product, with scope strips, window filters, builder co-editing, and transport-switching support mode. The library's centre of gravity is the standalone chat app.
