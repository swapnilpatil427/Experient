# Findings — Dana (Xperiq Backend Expert) — Round 2

Grounding facts I verified this round (backend/infra angle, confirming the brief's
premise):
- `crystalos/Dockerfile`: single `python:3.12-slim` image, non-root `appuser`, uvicorn
  started with `--workers 2`, no Docker-in-Docker, no k8s, no container-orchestration
  client library anywhere in the tree.
- `crystalos/lib/tool_dispatcher.py`'s own docstring: "Internal tools... are called
  directly via importlib — sub-millisecond overhead, **no subprocess**." This is an
  explicit, current statement that zero subprocess/sandbox infra exists today, not an
  inference.
- `crystalos/lib/security.py`: the service is "NOT internet-facing... sits behind the
  Node.js backend... the internal key is an additional defence-in-depth layer" — i.e.
  `X-Internal-Key` was designed from day one as a secondary control, not the primary
  trust boundary (Clerk-authenticated Express is the primary one).
- Root `fly.toml` (`app = "xperiq-api"`, the backend) runs on `shared-cpu-1x` / 256MB,
  `auto_stop_machines = true`. CrystalOS's own `fly.toml` isn't in this checkout (it
  deploys as a separate Fly app per `crystalos/CLAUDE.md`), but its Dockerfile's
  `--workers 2` and the backend's sizing pattern both point the same direction: small,
  cost-optimized machines, not a compute cluster with spare isolation capacity.
- `crystal/context.py`: `BrandContext.permitted_features`/`restricted_features` +
  `ROLE_PERMISSIONS`/`_resolve_permissions` is confirmed real and entirely
  CrystalOS-internal (resolved server-side, gates which tools a request may use) —
  matches Marcus's Round 1 read.

**Confirmed: the brief's premise is accurate.** CrystalOS today has no sandbox, no
subprocess execution, no container-orchestration surface, and a deployment footprint
(small VM, few async workers, no spare isolation capacity) that makes "just add a
sandbox" a nontrivial new ops investment, not an extension of existing capability.

---

## 1. Revised recommendation on Reframing #1 (extensibility)

**My Round 1 finding holds, with one refinement I'd now state more sharply in its
favor.**

Walking through the "generic list of post-processors" mechanism the same way I walked
through `applied_filters` in Round 1: such a mechanism — an ordered, named list of
functions that run after a skill produces its draft output, inside
`SkillRuntime.execute()`, each able to read/enrich the skill's internal output object
before it's serialized — is, by construction, invisible to Express **unless and until**
a specific registered processor decides to add a new field to the final response object
(the JSON dict `POST /insights/crystal` returns, or the SSE `type: "answer"` event) or
introduce a new SSE event `type`. The *mechanism* (how CrystalOS composes cross-cutting
concerns internally) and the *wire effect of any one instance registered into it* are two
separate questions, and only the second one can ever touch Express. This is the exact
same reasoning as Round 1's `applied_filters` analysis (§3 of my Round 1 doc) — the
extension point itself doesn't leak; a specific processor's *decision to surface new
data* is the only thing that can.

**Where I'd sharpen this, given the more forward-looking framing:** a *named, single*
extension point is actually a **wire-safety improvement** over today's status quo, not
neutral. Today, response-shape-affecting logic is scattered — `crystalHandler`'s SSE
pluck-list in `experience.ts` had to be updated ad hoc for `viz` (see Round 1 §3), and
nothing forces a CrystalOS engineer adding a new enrichment to know that Express has an
allowlist at all. If CrystalOS builds one ordered, named "post-skill-execution
processor" list — even zero-framework, purely in-house, just a Python list of callables
registered by name in one file — that becomes the single place to ask "which of these
processors adds a new top-level response field?" instead of hunting through `crystal.py`.
I'd recommend that whoever builds this (if anyone does) pair it with exactly one
process discipline: **any processor that adds a new top-level field to the response
object must update `crystalHandler`'s pluck-list in `backend/src/routes/experience.ts`
in the same PR** — a checklist item, not a code dependency. That's a small, concrete,
backend-safety-motivated argument *for* this specific narrow mechanism (not the
full middleware/hook framework Priya correctly ruled out) — it doesn't change my Round 1
"no rearchitecture" conclusion, but it does mean I'd actively support this one
narrow piece of forward-looking infrastructure on backend-safety grounds specifically,
independent of whatever engineering-velocity case Priya/Marcus make for it.

**The one scenario where the wire contract WOULD move, and it's forward-looking, not
retrospective:** if future post-processors (e.g., a code-interpreter validation step,
discussed below) want to narrate their own progress to the user in real time ("running
validation check..."), that pushes toward wanting **new SSE event types**, not just new
fields on the existing `answer` event. That is an additive, backward-compatible contract
change (old frontend code ignores unknown `type` values) but it *is* a genuine contract
extension, not an internal-only refactor — worth flagging now because Reframing #2 (code
interpreter) is exactly the kind of capability that would want this. I address it
concretely in §2 below.

## 2. Full design answer to Reframing #2 (code interpreter) — backend/infra/ops-safety
   angle

### 2.1 Where CrystalOS should sit on the isolation spectrum

Four points on the spectrum, evaluated against the confirmed infra facts above:

| Option | New infra footprint | Fits today's deployment? |
|---|---|---|
| (a) subprocess + resource/time limits, shared host | Needs OS-level network/resource controls (namespaces, cgroups, or an egress firewall) to make "no network egress" a real property, not a convention — none of that exists today, and the Dockerfile deliberately drops root (`USER appuser`) which most of these controls need. | No — would require re-adding privileges the current hardening explicitly removed, on a 2-worker async host where isolation failures have full-pod blast radius (see §2.4). |
| (b) fixed, pre-registered function library, no arbitrary code ever | **Zero new infra.** Dispatches through the exact same `dispatch_tool`/`ToolDispatcher` in-process, sub-millisecond, no-subprocess path every one of the other 58 tools already uses today. | **Yes — fits perfectly, today, with no new ops surface at all.** |
| (c) restricted-Python execution mode (e.g. an AST-restricted interpreter) | A new dependency + a security posture with a real historical CVE/escape track record for this exact class of tool, on a system with zero existing sandbox operational experience. | No — trades "no infra" for "new, unproven-in-this-codebase attack surface," worse tradeoff than (a) for the same non-benefit. |
| (d) real containerized/microVM sandbox (incl. Fly's own Machines API spinning a disposable, network-isolated machine per execution) | Genuine isolation, and notably *reachable without a new vendor* since CrystalOS already runs on Fly Machines — but still a wholly new ops surface: machine provisioning, health/cleanup-on-crash, cold-boot latency (not sub-second), cost per invocation. Nothing in CrystalOS's codebase manages machine lifecycles today. | Only if/when a concrete need for **genuinely novel, skill-authored code** (not just invoking a pre-built check) emerges — not today. |

**My recommendation: (b), and only (b), for the need Round 1 actually identified.**
Round 1's §3.1 finding was never "let the model write and run arbitrary scripts" — it
was "push provably-correct logic out of the LLM into a small, testable, deterministic
function." That is *exactly* served by a fixed, pre-approved, named function registry:
a skill's SKILL.md instructs it to invoke `validate_survey_logic` or
`check_prevalence_label_match` by name with structured JSON args, dispatched through the
same tool-call path every other CrystalOS capability already uses. There is no new
isolation boundary to build, because there is no arbitrary code ever entering the
process — every function is pre-written, code-reviewed CrystalOS source, shipped and
tested exactly like the rest of the codebase. This is the cheapest point on the
spectrum, and it fully satisfies the design intent.

I would explicitly **not** build (a), (c), or (d) right now. If a genuine future need
for skill-authored (not pre-built) code execution emerges, my ops-safety opinion is that
it should skip straight to (d) — via Fly's own Machines API, since it requires no new
vendor — and never land on (a) or (c) as an intermediate step; both of those give up
real isolation guarantees for the appearance of cheapness, on infra that has zero spare
capacity to absorb the failure modes described in §2.4.

### 2.2 How a skill would "call" this

Given CrystalOS's OpenRouter JSON-mode-only constraint (no native tool-calling loop),
there are two structurally different shapes, and I'd use both for different purposes,
matching how the brief poses the question:

1. **A new `TOOL_REGISTRY`/`crystal/tools.py` entry** (e.g. `run_validator(name, args)`),
   dispatched exactly like any of today's 58 tools, with the result fed back into the
   skill's own context so the model can react mid-turn (e.g., see a validation failure
   and revise its own draft before finishing). This is the right shape when the skill's
   *reasoning* genuinely benefits from seeing a specific result — the same UX as calling
   `get_topics` today.
2. **A new stage inside `SkillRuntime.execute()`'s existing retry loop**, running
   automatically after every skill draft, alongside/before `_check_evals`, feeding
   specific structured issues back into the existing "retry-once-with-failure-context"
   loop. This is the right shape for anything that should **gate** output quality rather
   than just inform reasoning — it matches Tier 2 #8 exactly as Round 1 described it, and
   it's the one I'd prioritize first, because it's fully automatic (no model discretion
   over whether to invoke it) and therefore trivially bounded in cost: it runs exactly
   once per skill-execution attempt, at a known point in the request lifecycle, capped
   the same way the retry loop itself already is.

**My preference, from the ops-safety seat specifically (not skill-authoring-design,
which is Priya/Marcus's call):** default to shape 2 for anything eval/quality-gating, and
reserve shape 1 only for checks a skill's own reasoning needs to see mid-turn. Shape 1
reopens a resource-bounding question CrystalOS already had to solve once — `_run_skill_stream`
caps context-tool calls at 3 per turn with no LLM-driven tool selection (per
`crystalos/CLAUDE.md`) specifically to bound worst-case fan-out. Any new validator
reachable as a model-invoked tool needs that exact same discipline applied to it (a
fixed per-turn call cap), or a single skill turn could invoke it an unbounded number of
times.

### 2.3 Security boundary — and does this change my `X-Internal-Key` assessment

For option (b) specifically: **no change to my Round 1 trust-model assessment.**
Dispatching a named, pre-reviewed function by name+JSON-args through the existing
`dispatch_tool` path is not a new privilege boundary — it's exactly as trusted as any of
the other 58 tools already reachable through that same path today. A buggy/compromised
skill supplying bad arguments to a validator function is bounded by whatever that
function itself validates (mirroring `security.py`'s existing input-length-capping
discipline, `MAX_INTENT_LEN`/`MAX_CONTEXT_STR_LEN`) — the same class of risk as a skill
mis-calling any existing tool with a bad argument, not a new category.

**For any hypothetical real sandbox (options (a)/(c)/(d)): yes, this changes the
picture, but not on the `X-Internal-Key` axis specifically.** `X-Internal-Key`
authenticates *which service* is calling CrystalOS (Express, not some other caller) —
it says nothing about what CrystalOS does once inside its own process. A sandbox's
failure modes (escape, resource exhaustion, exfiltration via network egress from inside
executed code) are entirely downstream of that boundary. So: the existing
internal-key-only boundary remains *sufficient for the job it does* — it does not
become weaker — but it is *irrelevant* to the new risk category a real sandbox
introduces. That would need a genuinely new boundary (OS user/namespace/VM isolation
around the executed code, inside CrystalOS's own process/machine model), not an
enhancement of the Express↔CrystalOS service-to-service key. This is, in fact, the
strongest argument for staying at option (b): it's the one point on the spectrum that
avoids ever needing to build that new boundary at all.

### 2.4 Cost/ops — what I'd want to see before this ships, mirroring CLS's
   "one bad graph construction hard-fails the pod" concern

CrystalOS's confirmed deployment shape (uvicorn async workers, `--workers 2`, small
Fly VM class) makes the blast radius of a runaway execution **structurally identical**
to CLS's concern, just at the request-handling layer instead of pod-startup: because
FastAPI/uvicorn workers are asyncio event loops serving many concurrent requests per
process, a single blocking/CPU-bound call inside one request handler — if not properly
bounded — can stall the **entire worker's event loop**, freezing every other concurrent
request that worker happens to be serving, not just the one that triggered it.

Before **any** code-execution capability ships (even option (b), where the risk is much
smaller since the functions are pre-reviewed and presumably already fast/bounded), I
would want to see, concretely:

1. **A hard wall-clock timeout enforced from outside the executed function's own
   control** (`asyncio.wait_for(...)` around the dispatch call at minimum), sized as a
   small slice of the existing `LLM_TIMEOUT_MS` (90s) ceiling most Express callers
   already allow per CrystalOS round-trip — not something that can itself consume the
   whole budget.
2. **Memory/resource caps independent of the timeout** — a function that returns within
   its time budget can still exceed the machine's small memory ceiling on an unexpectedly
   large input and OOM-kill the whole worker (taking every other in-flight request on
   that worker down with it — the direct memory-axis analogue of CLS's concern). For
   option (b), this is bounded primarily by input-size validation at the call boundary
   (the same "cap it before it reaches expensive work" pattern `security.py` already
   applies to `MAX_INTENT_LEN`/`MAX_CONTEXT_STR_LEN`) — the same discipline should extend
   to whatever arguments a validator function accepts.
3. **A concurrency cap decoupled from Express's existing per-org rate limit.** Express
   already rate-limits Crystal turns (10-20 req/org/min depending on route), but that
   bounds *conversation turns*, not *concurrent validator invocations* — several orgs'
   turns landing on the same worker simultaneously, or one skill fanning out multiple
   checks, could still stack up more concurrent executions than a 2-worker/small-VM
   machine can absorb. A small in-process semaphore (a handful of concurrent executions
   per worker) turns a burst into queuing/backpressure instead of resource exhaustion —
   directly analogous to `_run_skill_stream`'s existing "≤3 context tool calls, no
   LLM-driven selection" cap.
4. **No network egress, enforced structurally, not by convention.** For option (b) this
   is essentially free — don't give the pre-approved functions an HTTP client or
   credentials in scope, enforced by code review like every other tool executor in
   `crystal/tools.py`. For any future real-sandbox option, "no network" must be an
   actual OS-enforced property, not a documentation comment.
5. **One crash-isolation regression test, before ship, not after** — a test that fires a
   deliberately hanging/deliberately memory-heavy call concurrently with a normal request
   on the same process and asserts the normal request still completes within its own
   SLA. This is the direct CrystalOS-specific analogue of the exact lesson the synthesis
   doc already cites from CLS (`02`) — "one bad graph construction hard-fails the entire
   pod" — applied to the request layer instead of startup. I'd treat this single test as
   a **ship-blocking** requirement regardless of which point on the isolation spectrum is
   chosen, because it's cheap to write and it's the one test that actually proves the
   blast-radius question rather than assuming it away.

### 2.5 Concrete pilot candidates

Both of Round 1's own suggested skills already have their deterministic check
**hand-wired today** — the "pilot" for option (b) is extracting existing inline logic
into a small, named, independently-testable registry, not building anything new from
scratch:

- **`survey-creator`**: the existing ID-fix/skip-logic-integrity guards (per
  `crystalos/CLAUDE.md`'s "Survey skills are skill-first with legacy fallback" section)
  are already exactly this shape of deterministic check, just not exposed as a
  callable-by-name registry entry yet.
- **Custom Analysis's `trust_score` cap**: "`trust_score` capped at 55 when n <
  `custom_analysis_min_n_for_nps`" is documented in `crystalos/CLAUDE.md` as a **hard
  invariant** already — precisely the "prevalence label matches percentage"-class rule
  Round 1's synthesis doc named as a Tier 2 #8 candidate.

Both pilots are ops-neutral: they reuse the existing in-process, sub-millisecond,
no-subprocess `dispatch_tool` path with zero incidents to date, and need none of the
§2.4 timeout/memory/concurrency work beyond what code review of a small, well-scoped
Python function already provides.

## 3. Revisions to my Round 1 findings

1. **Sharpening, not reversing, my Tier 2 #10 "zero backend impact" statement.** That
   holds only as long as post-processors never introduce new response-facing fields *or*
   new transport needs (e.g. progress narration). Reframing #2's code-interpreter
   discussion surfaces a concrete case (a validator step wanting to stream "running
   check..." progress) where the second half of that assumption could be tested — I'd
   add this as an explicit caveat to my Round 1 §3 entry for Tier 2 #10, not change the
   conclusion itself.
2. **New grounding, same conclusion.** This round's confirmed infra facts (2 async
   uvicorn workers, small Fly VM class, zero existing subprocess/sandbox surface) weren't
   verified in Round 1 but reinforce my Round 1 recommendation ("adopt selected patterns
   only") with a concrete, infra-specific reason rather than just "no evidence of need":
   CrystalOS's current deployment has essentially zero spare isolation capacity to
   absorb a heavier code-execution option without new, non-trivial ops investment it
   doesn't have today. That's a reason to stay at the cheap end of the spectrum (option
   (b)) that I couldn't state this precisely in Round 1.
