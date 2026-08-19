# Team — xperiq-assistant-ui (minimal assistant-ui adoption)

Per root `CLAUDE.md`'s Team-Driven Implementation Protocol. Scope is deliberately
small — see `BRIEF.md` — so this team is 3 members, not a full 5-person pod.

## Priya — Product
- **Owns**: scope discipline. The one job of this branch is "does Crystal chat get
  a real, visible upgrade (multi-thread history) with zero CrystalOS/backend changes."
  Anything that requires a new backend endpoint is out of scope for this pass — flag
  it as a "Phase 2" candidate instead of building it.
- **Skills**: product scoping, acceptance-criteria writing, saying no to feature creep.

## Jordan — UX / Design
- **Skills**: interaction design for chat/thread-switcher UX, accessibility (keyboard
  nav, screen-reader labels on thread list items), brand-token theming review (Xperiq's
  `--color-primary`/`--color-tertiary` CSS var system, not assistant-ui's own default
  palette hardcoded).
- **Owns**: reviewing the built UI against Xperiq's existing brand system and basic
  a11y before it's considered done.

## Marcus — Frontend Engineer
- **Skills**: React 19, TypeScript, Vite, `@assistant-ui/react`, Tailwind v4.
- **Owns**: the actual implementation — see `BRIEF.md` for exact scope. Wires
  assistant-ui's own default-styled `Thread`/`Composer`/`Message` components (not a
  custom hand-built re-implementation) to Xperiq's existing Crystal REST endpoint,
  plus a `localStorage`-backed `ExternalStoreThreadListAdapter` for multi-thread
  history — the one thing Crystal doesn't have today.
