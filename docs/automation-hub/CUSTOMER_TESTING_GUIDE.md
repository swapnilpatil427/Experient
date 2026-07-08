# Xperiq Actions — Customer Testing Guide

**Purpose:** a step-by-step script for a customer (or anyone acting as one) to manually
verify the workflow automation feature end-to-end, covering the bug that was reported
and everything built around it.

**Before you start:** get the app running locally —
```bash
nvm use 22
npm run install:all && npm run setup:agents
npm run dev:dev-paid
```
Then open `http://localhost:5173`, sign in (dev mode auto-signs in as `dev-user`/`dev-org`
if Clerk isn't configured), and navigate to **Workflows** in the left nav
(`/app/workflows`).

---

## Scenario 1 — The original bug: schedule a Weekly Digest

This is the exact thing that was broken. Confirm it now works.

1. From the Workflows list, click **Templates** (or use the "Weekly Digest" seed
   template if offered) — or just click **Create a workflow** and build it manually.
2. In the sentence builder, click **`+ pick a trigger`**.
3. Under the **Time** category, select **"On a schedule (cron)"**.
4. You should see a human-friendly picker — NOT a raw cron field:
   - Frequency toggle: Daily / Weekly / Monthly / Custom interval
   - Pick **Weekly**, then check **Monday**
   - Set time to **9:00 AM**
   - Confirm the timezone shown matches your browser's timezone
5. **Expected:** a live preview line updates as you change fields, e.g. *"Runs every
   Monday at 9:00 AM [your timezone] · Next run: [an actual future date]"* — never a
   blank or placeholder value.
6. Click **Done** — the sentence should now read something like *"When 'Every Monday
   at 9:00 AM' on..."*
7. **Save the workflow, then re-open it in edit mode.** This is the critical
   regression check: the schedule must show "Monday, 9:00 AM" again — **not**
   "Custom expression (not representable in picker)". If you see that string, the
   fix has regressed.

✅ Pass condition: you can create and re-edit a weekly schedule without ever seeing
raw cron syntax, and the next-run date is always a real, computed date.

---

## Scenario 2 — Scope a workflow to one survey

This is the second reported gap ("how would I select which survey?").

1. Create a new workflow. Pick any trigger that isn't "On a schedule" (e.g. **NPS
   Dropped**) — schedule/webhook triggers intentionally can't be survey-scoped.
2. Click **`+ choose scope`**.
3. You should see three clear options: **Org-wide**, **A specific survey**, **A tag /
   group** — each with a one-line description of what it means.
4. Pick **A specific survey**, then search for and select a real survey from your org.
5. **Expected:** the sentence now reads *"...on Survey: [survey name] then..."*, and a
   consequence line told you *"This workflow will only consider responses from
   [survey name]"* before you confirmed.
6. Save, then go back to the **Workflows list**. Confirm the new workflow's card shows:
   - A colored left-edge stripe (a distinct color for survey-scoped vs. org-wide)
   - A visible chip reading `Survey: [name]` — **without clicking anything**
7. Use the scope filter bar above the list (`All / Org-wide / By survey / By tag`) to
   filter down to just that survey and confirm the workflow appears.

✅ Pass condition: scope is unmissable both while building and while browsing the list.

---

## Scenario 3 — Scope a workflow to a tag group

1. Repeat Scenario 2, but pick **A tag / group** instead of a survey.
2. Confirm the tag picker shows how many surveys the tag currently covers (e.g.
   "Onboarding — 4 surveys") before you confirm.
3. Confirm the list card shows a **different color** stripe/chip than the survey-scoped
   one (tag = purple/accent, survey = brand primary, org-wide = neutral gray, per the
   design — exact colors may vary with your org's brand theme).

---

## Scenario 4 — Customize what's in a report/email (drop the Crystal summary)

This is the third reported gap.

1. Create or edit a workflow, and for an action click **`+ add action`**.
2. Pick **Slack message** or **Email** (either is a "content-producing" action).
3. **Expected:** a two-column panel opens — a checklist of sections on the left
   (Crystal AI Summary, Key Metrics, Trend Chart, Top Verbatims, etc.) and a live
   preview on the right.
4. Uncheck **"Crystal AI Summary."**
5. **Expected:** the summary block disappears from the preview immediately — you
   should not need to save or refresh to see the change.
6. Save the workflow, re-open it, and confirm the Crystal Summary checkbox is still
   unchecked (the choice persisted, not just visual).

✅ Pass condition: you can exclude the Crystal summary (or any other section) from a
report/email, see the consequence live, and have it stick after save/reload.

---

## Scenario 5 — Multi-action workflow

1. Continue the workflow from Scenario 4 — click **`+ add action`** again and add a
   second action (e.g. a Jira ticket, or a second Slack message to a different
   channel).
2. **Expected:** the sentence grows a second `, then [action]` clause; both actions
   are listed and independently configurable (each has its own content checklist if
   applicable).
3. Try dragging to reorder the two actions.

---

## Scenario 6 — Cooldown (avoid duplicate alerts)

1. Open a workflow's settings (small gear/settings affordance near Save).
2. Set a cooldown, e.g. **4 hours**.
3. Save, then re-open — confirm the cooldown setting persisted (not reverted to
   default).
4. If the workflow's trigger is a schedule, confirm cooldown is shown as **"Not
   applicable"** and disabled — schedule triggers throttle themselves.

---

## Scenario 7 — Natural-language workflow creation (Crystal)

1. From the Workflows list, click **"Build with Crystal"**.
2. Type a plain-English description, e.g. *"Alert #cx-team on Slack when NPS drops
   below 30 on the CSAT survey."*
3. **Expected:** a "thinking" animation plays briefly, then a confirm-card appears
   showing the proposed trigger/scope/action in human-readable form (not raw JSON),
   with a confidence indicator.
4. Try an intentionally vague/nonsensical description (e.g. *"do the thing"*) and
   confirm you get a clear "couldn't understand that" message with example prompts to
   try — not a silent failure or a broken workflow.
5. If confidence is shown as low on a real attempt, confirm there's no way to blindly
   click "Create" without reviewing — you should be routed to "edit before creating."

---

## Scenario 8 — Crystal chat can propose a workflow mid-conversation

1. Open the Crystal side panel (chat) from within a survey.
2. Ask something like *"Can you set up an alert for when NPS drops?"*
3. **Expected:** Crystal may respond with a workflow proposal card (not just text) —
   confirming it creates a real workflow visible on the Workflows list afterward.

---

## Scenario 9 — Advanced: branching logic (power users)

1. From the sentence builder, find the **"Advanced: Branching Canvas"** link (near
   Save).
2. Confirm it hands off your in-progress trigger/name into a visual canvas builder
   where you can add **if/else branches** (e.g. "if NPS < 30 send to Slack, else send
   to email") — this is the one thing the sentence builder intentionally doesn't do.

---

## Scenario 10 — Integrations (if you have real credentials)

1. In org settings, look for workflow connector credentials (Jira/Zendesk/Slack/
   webhook).
2. Add real credentials for one connector.
3. Create a workflow using that connector's action (e.g. **Create Jira ticket**) and
   use **Test Run** to confirm it actually creates a real ticket.
4. Remove/leave credentials unset for another connector and confirm the action
   degrades gracefully (shows "not configured," doesn't crash the workflow).

---

## Scenario 11 — AI-driven triggers (advanced, needs real survey traffic)

These triggers fire from Crystal's own analysis, not a simple threshold — hardest to
test without live data, but worth checking they're at least selectable:

1. In the trigger picker, confirm you can select **"Sentiment Spike Detected,"**
   **"Anomaly Detected,"** and **"New Emerging Theme"** — each should show a small
   **[Crystal]** badge signaling it's AI-driven.
2. These require actual response volume and a completed insight-pipeline run to ever
   fire in practice — this scenario is about UI selectability, not real-time
   verification, unless you have a survey with enough live traffic to trigger one
   naturally.

---

## Known gaps — don't file these as new bugs, they're already tracked

- NPS-threshold trigger's numeric config field (e.g. "below 30") isn't built yet —
  you can select the trigger but can't set the exact number.
- No true end-to-end test has been run against live production infrastructure
  (Postgres + Redis + CrystalOS all running together) — everything above has been
  verified via automated tests, not a live production dry-run.
- The workflow list page doesn't yet show a "🕐 Cooldown — resets in 47 min" live
  countdown pill (the backend data exists, the display isn't wired in yet).
- Asking Crystal "what workflows do I have running?" in chat won't be answered — that
  read capability doesn't exist yet (Crystal will say so rather than guess).

---

## What to report if something fails

For each scenario, useful bug-report details are: which step failed, what you expected
vs. what happened, and (if possible) the browser console output. Reference the scenario
number (e.g. "Scenario 1, step 6") so it's easy to trace back to the exact flow.
