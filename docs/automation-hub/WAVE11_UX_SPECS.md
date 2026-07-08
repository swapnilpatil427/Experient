# Wave 11 UX Specs — Condition Step + `flow.delay` Config UI

**Author:** Rohan Desai (Principal Product Designer, Builder Experiences)
**Date:** 2026-07-02
**Scope:** Spec only — no code. Elias builds from this in Phase 2, after Priya's
`flow.delay` engine work (Phase 1) is verified. Both tasks below are scoped
**additively** against the live sentence builder (`WorkflowBuilderPage.tsx`) per
this wave's explicit "very safe integration" bar — nothing here changes an
existing pill's default behavior, an existing payload field's meaning, or an
existing component's props in a breaking way.

**Method:** Read `WorkflowBuilderPage.tsx`, `ScheduleTriggerConfigPanel.tsx`
(`components/workflow-builder/panels/`, not `sentence/` — corrected path, see
note in Task 2), `WorkflowCanvasPage.tsx`'s `ConditionNode`, `SentencePill.tsx`,
`ActionClauseList.tsx`, `StepPanel.tsx`, `TriggerStepPanelContent.tsx`/
`ActionStepPanelContent.tsx`, `SimpleActionConfigForm.tsx`,
`backend/src/lib/workflowRegistry.ts`, and `workflowEngine.ts`'s
`evaluateConditions`/`runNodes`/`compare` directly — every data-flow claim below
is traced to source, not assumed.

---

## Pre-read: what I confirmed in the engine before designing anything

1. **`evaluateConditions` is pure AND-by-default, OR only if explicitly set.**
   (`workflowEngine.ts` lines 139–144):
   ```ts
   const op = (conditions.operator || 'AND').toUpperCase();
   const results = conditions.rules.map((r) => compare(r.op, context[r.field], r.value));
   return op === 'OR' ? results.some(Boolean) : results.every(Boolean);
   ```
   `ConditionSet` is `{ operator?: 'AND' | 'OR', rules?: ConditionRule[] }`. The
   sentence builder has never populated this field on any node — Task 1 is a
   **net-new** capability, not a fix to something half-wired. Because the
   engine already supports an explicit `OR`, I could technically spec an OR
   toggle — I'm **not** doing that this wave (see "Explicitly deferred" below).
   The sentence builder will only ever write `operator: 'AND'` (or omit it,
   same effect), matching the "plain 'and' language" ask exactly and keeping
   the UI surface smaller for a first pass.

2. **Zero conditions today = always-fires, unconditionally.** A `WorkflowNode`
   of `type: 'condition'` is a distinct node in the `nodes` array
   (`runNodes`, `workflowEngine.ts` ~line 423); if no condition node exists,
   `runNodes` never calls `evaluateConditions` at all and goes straight from
   trigger to actions. This is the exact backward-compatibility contract Task
   1 must preserve: **a workflow with no condition pill must produce
   byte-identical `nodes`/`edges` output to what `serialize()` produces
   today.**

3. **The registry's condition data is already fetched by `WorkflowCanvasPage`
   but not by `WorkflowBuilderPage`.** `GET /api/workflows/registry` returns
   `conditionFields: ConditionFieldDef[]` (`{ field, label, kind }`) and
   `conditionOperators: string[]` (`CONDITION_OPERATORS` —
   `['eq','neq','gt','lt','gte','lte','between','contains','not_contains','in','not_in']`).
   `WorkflowCanvasPage.tsx`'s existing `useEffect` (lines 104–113) already
   destructures both off the same `api.getWorkflowRegistry()` call
   `WorkflowBuilderPage.tsx` makes today (line 192) — the sentence builder
   just never reads those two fields off the response. No second source of
   truth is being introduced; this is one extra destructure off data already
   in flight.

4. **`flow.approval`'s pause contract is exactly what Priya's `flow.delay` will
   reuse** (`workflowEngine.ts`'s `executeAction` switch, per
   `DEEP_AUDIT_UX_FINDINGS.md` §9): `{ status: 'waiting', output: {...},
   pause: true }`. On the frontend, `flow.approval`'s only config today is a
   single free-text `approverEmail` field via `SimpleActionConfigForm`
   (`FIELDS_BY_ACTION['flow.approval']`) — there is no existing "Flow action
   config" pattern beyond that generic form. `flow.stop` has zero fields
   (`FIELDS_BY_ACTION['flow.stop']: []`). Neither the sentence builder's
   `ActionTile` nor the canvas's `ActionNode`/`SHELL` currently give
   `category: 'Flow'` actions any distinct color, icon, or treatment in the
   **sentence builder specifically** — the canvas's colored top-border
   (`#d97706` for condition, category-keyed) is a canvas-only convention, not
   shared with the sentence builder's `ActionTile`/`ActionClauseList`. So Task
   2's "does Flow need a distinct icon" is a real, currently-unaddressed gap,
   not a pattern I'm contradicting.

5. **Path correction:** the task brief cites
   `app/src/components/workflow-builder/sentence/ScheduleTriggerConfigPanel.tsx`.
   The real path is `app/src/components/workflow-builder/panels/ScheduleTriggerConfigPanel.tsx`
   (imported into `sentence/TriggerStepPanelContent.tsx` from `../panels/`).
   Noted so Elias doesn't spend time looking in the wrong directory. The
   pattern description below matches the actual file.

---

## TASK 1 — Condition step in the sentence builder

### 1.1 Where it sits in the pill sequence

**Between scope and action, confirmed — not proposing otherwise.** The
sentence becomes:

> When **[trigger]** on **[scope]** if **[condition]** then **[action], [action]…**

This reads correctly as English (trigger → scope → qualifying filter → what
happens) and matches the engine's own execution order: `runNodes` evaluates
the condition node immediately after the trigger fires and scope has already
gated which events reach the workflow at all (scope filtering happens
upstream, at the trigger-dispatch level, before `runNodes` even starts — see
`resolveEventSurveyId` — so by the time a condition would evaluate, scope has
already been applied). Putting "if" after "on" mirrors that: scope narrows
*which surveys/tags* the workflow listens to; the condition narrows *which
individual events*, on top of that. Reversing the order (condition before
scope) would misrepresent this — a customer would read "if NPS < 30 on
Org-wide" as if the condition applies before scoping, which isn't how the
engine evaluates it.

### 1.2 Zero-condition default state — hard backward-compatibility constraint

**A workflow with no condition pill added must behave exactly as it does
today: it always fires when trigger + scope match, no condition node in the
serialized graph at all.**

Concretely:
- New builder state: `const [conditionClauses, setConditionClauses] = useState<ConditionClause[]>([])`
  — an array from the start (see 1.4 for the "+Add condition" multi-condition
  UI this same state backs), starts `[]` for every new workflow and for every
  existing workflow loaded via `hydrateFromNodes` that has no condition node
  in its saved `nodes` array.
- `serialize()` in `WorkflowBuilderPage.tsx` (lines 383–416) must **only**
  push a `{ type: 'condition', ... }` node into the `nodes` array when
  `conditionClauses.length > 0` (see 1.4). When it's empty, `serialize()`'s
  output must be **identical** to today's — same node count, same edge chain,
  same shape. This is the literal mechanism of backward compatibility: no
  condition state → no condition node → `runNodes` never calls
  `evaluateConditions` → behavior is unchanged.
- **Elias must add a regression test proving this**, mirroring the existing
  pattern for the Wave 10 "active workflow stays active" fix: save a workflow
  with a trigger + scope + action and no condition, assert the resulting
  `nodes` array has exactly `{trigger, action}` node types (no `condition`),
  and assert `evaluateConditions` is never reached for it at execution time
  (or, at minimum, assert the persisted `nodes` array is unchanged from a
  pre-Wave-11 snapshot for the same input). This is the single most important
  test in this wave's frontend surface — it's the thing that keeps every
  workflow saved before this feature existed working identically after.

### 1.3 The step-panel content for one condition

New component: **`ConditionStepPanelContent.tsx`**, placed alongside
`TriggerStepPanelContent.tsx`/`ActionStepPanelContent.tsx` in
`app/src/components/workflow-builder/sentence/`. Same file-per-step-type
convention, same "reads the registry, doesn't own its own copy of the data"
pattern.

```ts
export interface ConditionField { field: string; label: string; kind: 'number' | 'string' }

export interface ConditionClause {
  id: string;         // client-only, same newActionId()-style generator, for the +Add list / dnd-kit key
  field: string;       // one of ConditionField.field
  op: string;           // one of CONDITION_OPERATORS
  value: string;        // always stored as string in UI state; coerced at serialize time per field.kind
}

export interface ConditionStepPanelContentProps {
  fields: ConditionField[];       // from GET /api/workflows/registry's `conditionFields`
  operators: string[];            // from GET /api/workflows/registry's `conditionOperators`
  clauses: ConditionClause[];     // 0..N — empty array is the valid "no condition" state
  onChange: (clauses: ConditionClause[]) => void;
}
```

**Single-condition row layout** (mirrors `SimpleActionConfigForm`'s "one row,
label above, `space-y-3` between rows" rhythm, but each condition is one
horizontal row of three controls, not stacked — closer to
`WorkflowCanvasPage.tsx`'s `ConditionNode` inline row than to a vertical form,
since three short controls read better as one line):

```tsx
<div className="flex items-center gap-2" data-testid={`condition-row-${clause.id}`}>
  <Select value={clause.field} onValueChange={(v) => updateClause(clause.id, { field: v, value: '' })}>
    {/* SelectTrigger/SelectContent, options = fields.map(f => ({value: f.field, label: f.label})) */}
  </Select>
  <Select value={clause.op} onValueChange={(v) => updateClause(clause.id, { op: v })}>
    {/* options = operators, rendered via a fixed OPERATOR_LABELS map — see 1.3a below,
        never render the raw engine token ('gte') as user-facing copy */}
  </Select>
  {fieldKind(clause.field) === 'number' ? (
    <Input type="number" className="w-24" value={clause.value} onChange={(e) => updateClause(clause.id, { value: e.target.value })} />
  ) : (
    <Input type="text" className="w-40" value={clause.value} onChange={(e) => updateClause(clause.id, { value: e.target.value })} placeholder={t('workflows.builder.sentence.condition.valuePlaceholder')} />
  )}
  <button type="button" aria-label={t('workflows.builder.sentence.condition.removeAria')} onClick={() => removeClause(clause.id)}>
    <Icon name="close" size={14} />
  </button>
</div>
```

- Field dropdown defaults to `fields[0]?.field` when a brand-new clause is
  added (same "first item is the sane default" pattern
  `WorkflowCanvasPage.tsx`'s `addCondition()` uses: `conditionFields[0]?.field
  ?? 'nps'`).
- **Changing the field resets `value` to `''`** (shown in `updateClause` above)
  — a leftover string value from a `number`-kind field (e.g. `"30"`) is
  harmless if the new field is also `number`, but silently wrong if the user
  switches from `nps` (number) to `sentiment` (string) and the stale numeric
  string is submitted as a string-equality check. Resetting on field-change
  avoids a whole class of "the condition never matches and nobody knows why"
  support tickets.
- `between` operator is a special case: `compare()`'s `between` branch expects
  `value` to be an **array** of two numbers (`Array.isArray(value) &&
  Number(actual) >= Number(value[0]) && Number(actual) <= Number(value[1])`).
  **Scope decision for this wave: `between` is excluded from the operator
  dropdown's rendered options.** It's a real engine capability but needs a
  two-input range UI (min/max) that doesn't fit the single-value-input row
  spec'd above, and nothing in this wave's ask requires it. Filter it out in
  the component: `operators.filter((op) => op !== 'between')`. This is a
  UI-only omission — the engine still supports `between` for anything that
  sets it directly (e.g. a future canvas enhancement); the sentence builder
  simply doesn't expose it yet. Flagging explicitly per the "don't gold-plate,
  note what's deferred" instruction.

**1.3a — Operator label map (never render raw tokens as copy):**

```ts
// ConditionStepPanelContent.tsx
const OPERATOR_LABEL_KEYS: Record<string, string> = {
  eq: 'workflows.builder.sentence.condition.op.eq',                 // 'is'
  neq: 'workflows.builder.sentence.condition.op.neq',                // 'is not'
  gt: 'workflows.builder.sentence.condition.op.gt',                  // 'is greater than'
  lt: 'workflows.builder.sentence.condition.op.lt',                  // 'is less than'
  gte: 'workflows.builder.sentence.condition.op.gte',                // 'is at least'
  lte: 'workflows.builder.sentence.condition.op.lte',                // 'is at most'
  contains: 'workflows.builder.sentence.condition.op.contains',      // 'contains'
  not_contains: 'workflows.builder.sentence.condition.op.notContains', // 'does not contain'
  in: 'workflows.builder.sentence.condition.op.in',                  // 'is one of'
  not_in: 'workflows.builder.sentence.condition.op.notIn',           // 'is not one of'
};
```
`in`/`not_in` also technically expect an array value per `compare()` — same
scoping call as `between`: **this wave's UI treats them as a single
comma-separated string** the user types (e.g. `urgent, billing`), and
`serialize()` splits on `,` and trims before writing the `value` array to the
condition node's `value` field. This keeps the single-text-input row uniform
across every operator except number-vs-string `kind`, at the cost of a
slightly less guided input for `in`/`not_in` — an acceptable, explicitly-noted
trade for "very safe/incremental" rather than building a tag-input control
this wave.

### 1.4 Multiple conditions — confirmed pure AND, spec matches

Per the pre-read: `evaluateConditions` is AND unless `operator: 'OR'` is set,
and the sentence builder will never set `operator` to anything but the
implicit AND default. So:

- **"+Add condition" pattern, plain "and" between pills** — exactly as the
  task brief proposed, confirmed correct against the engine. In the resting
  sentence (not the step-panel — the step-panel is where clauses are
  authored; the resting sentence shows the summary pill, see 1.5):
  > ...if **[NPS < 30]** and **[tag contains "urgent"]** then...
- Inside `ConditionStepPanelContent`, render `clauses.map(...)` as a vertical
  stack of the row from 1.3, each with its own remove (×) button, plus a
  trailing:
  ```tsx
  <button type="button" onClick={addClause} className="text-sm font-semibold text-primary hover:underline">
    {t('workflows.builder.sentence.condition.addAnother')}  {/* "+ add another condition" */}
  </button>
  ```
  This directly mirrors `ActionClauseList`'s "+ add another action" link
  styling/position (`text-sm font-semibold text-primary hover:underline`) —
  same visual grammar, not a new one.
- **No OR toggle, no per-pair operator picker.** If the engine's `evaluateConditions`
  is ever extended to support mixed AND/OR groups (it currently only supports
  one global operator for the whole rule set, not per-pair), that's a new
  spec, not a retrofit of this one.
- `serialize()` writes multiple clauses as one condition node with `rules: [...]`
  (matching the `ConditionSet`/`ConditionRule` shape 1:1) — **not** multiple
  condition nodes. This matters for the zero-condition backward-compat
  contract too: 1 condition node when `clauses.length > 0`, 0 condition nodes
  when `clauses.length === 0`, never partial.

### 1.5 The condition pill in the resting sentence

New pill, inserted into `WorkflowBuilderPage.tsx`'s sentence row between the
scope pill and the `then` word:

```tsx
<span className="text-on-surface-variant font-medium">{t('workflows.builder.sentence.if')}</span>
<SentencePill
  testId="pill-condition"
  state={conditionClauses.length === 0 ? 'empty' : 'filled'}
  label={conditionPillLabel}
  onClick={() => setOpenStep('condition')}
  disabled={openStep !== null && openStep !== 'condition'}
/>
```

- **The "if" word and the condition pill are both optional/absent-by-default
  in spirit but always rendered** — i.e., don't conditionally hide the "if"
  word or the pill based on whether a condition is set. Precedent:
  the scope pill is always rendered even though "Org-wide" is itself a kind of
  default/no-op scope — the sentence's whole promise is a fixed, always-visible
  spine, and conditionally removing/inserting words based on state would
  reintroduce the layout-shift problem the sentence model was built to avoid.
  An empty condition pill reads "+ add a condition (optional)" so it's
  self-evidently skippable, not a required blank the user feels blocked on.
- **Pill label when empty:** `t('workflows.builder.sentence.pill.pickCondition')`
  → `"+ add a condition (optional)"` — the `(optional)` suffix is
  load-bearing copy, not decoration: every other empty pill in this sentence
  (`pickTrigger`, `addAction`) is implicitly required to save; this is the
  first pill that is explicitly not, and a first-time user has no other
  signal telling them that. Confirmed via `canSave`'s current definition
  (`Boolean(name.trim() && triggerType && hasActions)`) — condition must
  **not** be added to this check.
- **Pill label when filled, single condition:** reuse the field's registry
  label + the operator's short symbol/word + the value, e.g. `"NPS < 30"` for
  `{field: 'nps', op: 'lt', value: '30'}` — a compact symbolic rendering
  (`<`, `>`, `=`, `≠`, `≥`, `≤` for the six comparison ops; the label-key text
  for `contains`/`not_contains`/`in`/`not_in`, since those don't have a clean
  symbol). Build via a small `conditionPillLabel` memo in
  `WorkflowBuilderPage.tsx`, same pattern as `triggerPillLabel`/`scopePillLabel`
  (lines 343–357):
  ```ts
  const CONDITION_OP_SYMBOL: Record<string, string> = {
    eq: '=', neq: '≠', gt: '>', lt: '<', gte: '≥', lte: '≤',
  };
  const conditionPillLabel = useMemo(() => {
    if (conditionClauses.length === 0) return t('workflows.builder.sentence.pill.pickCondition');
    if (conditionClauses.length === 1) {
      const c = conditionClauses[0];
      const fieldLabel = fields.find((f) => f.field === c.field)?.label ?? c.field;
      const symbol = CONDITION_OP_SYMBOL[c.op] ?? t(OPERATOR_LABEL_KEYS[c.op] ?? '');
      return `${fieldLabel} ${symbol} ${c.value}`;
    }
    return t('workflows.builder.sentence.pill.conditionCount', { count: conditionClauses.length });
  }, [conditionClauses, fields, t]);
  ```
  **Filled, 2+ conditions:** collapse to a count summary in the resting pill
  (`"2 conditions"`) rather than trying to cram `"NPS < 30 and tag contains
  'urgent'"` into one pill — that string grows unboundedly with each added
  condition and breaks the pill's fixed-width visual grammar. Full detail is
  only in the step-panel, which is consistent with how the action pills work
  today (each action is its own compact pill; you reopen the step-panel to
  see full config).
  - **Correction to the task brief's literal example:** the brief's illustrative
    sentence — `"IF [NPS < 30] and [tag contains 'urgent']"` — describes two
    *separate* pills joined by "and" directly in the resting sentence. I'm
    deliberately not doing that (one pill per condition inline) for the same
    reason as above: 2+ inline pills for conditions, on top of the existing
    inline action-clause pills, risks the exact "wraps into a tall stack of
    short lines" problem §7 of the audit already flagged for 4–5 action pills.
    One summary pill that expands to the full per-condition list in the
    step-panel is the safer, more scalable pattern — Elias should build the
    single-summary-pill version above, not literal inline multi-pills.

### 1.6 Visual glyph for the condition pill

**Dashed border, filter icon, amber-tinted (not primary-tinted) when filled** —
distinct from both action pills (solid, primary-tinted, in
`ActionClauseList.tsx`) and the trigger/scope pills' `filled` state (also
primary-tinted). Extend `SentencePillState` with a 4th value —
this is an additive change to `SentencePill.tsx`'s existing 3-state union
(`'empty' | 'filled' | 'invalid'`), not a rename of any existing state, so
every current call site (`pill-trigger`, `pill-scope`, `pill-add-action`)
compiles and renders unchanged:

```ts
export type SentencePillState = 'empty' | 'filled' | 'invalid' | 'condition';
```

```tsx
// SentencePill.tsx — additive branch inside the existing cn(...) call
state === 'condition' && 'border-2 border-dashed border-warning/60 text-warning bg-warning/5 hover:bg-warning/10',
```

Plus a leading icon specific to the condition pill (the other three states
render no leading icon today — only a trailing edit-pencil on hover). Add an
optional `icon` prop rather than hardcoding "filter_alt" inside `SentencePill`
itself (keeps the component generic — a future pill type shouldn't require
editing `SentencePill.tsx`'s internals again):

```ts
export interface SentencePillProps {
  state: SentencePillState;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  icon?: string;   // NEW, optional — Material Symbol name, rendered before the label
}
```

```tsx
{icon && <Icon name={icon} size={13} className="opacity-70" />}
<span>{label}</span>
```

Call site in `WorkflowBuilderPage.tsx`:
```tsx
<SentencePill
  testId="pill-condition"
  state={conditionClauses.length === 0 ? 'empty' : 'condition'}
  icon="filter_alt"
  label={conditionPillLabel}
  onClick={() => setOpenStep('condition')}
  disabled={openStep !== null && openStep !== 'condition'}
/>
```
`filter_alt` is not a new icon choice — it's the exact icon
`WorkflowCanvasPage.tsx`'s `ConditionNode` and the canvas header's "Add
condition" button already use for the same concept (lines 253, 328), so a
customer who has seen the canvas once recognizes the glyph immediately in the
sentence builder too. Empty state stays the existing dashed-outline-variant
look (no icon, matching how `pill-add-action`'s empty state has none) so the
optional/skippable affordance isn't visually competing with the filled
amber-warning treatment.

### 1.7 Data flow summary (Task 1)

- `WorkflowBuilderPage.tsx` gains: `conditionClauses: ConditionClause[]` state
  (init `[]`); reads `conditionFields`/`conditionOperators` off the existing
  `api.getWorkflowRegistry()` call (same `useEffect`, lines 191–230 — just
  destructure the two extra fields already in the response); a new
  `'condition'` member on the `StepId` union (`'trigger' | 'scope' | 'action'
  | 'condition' | null`); a new `StepPanel` block rendering
  `ConditionStepPanelContent`, positioned between the scope and action
  `StepPanel`s in JSX (matching the sentence's left-to-right order).
- `hydrateFromNodes()` (lines 88–122) gains a fourth destructured field:
  finds `nodes.find((n) => n.type === 'condition')`, maps its
  `conditions.rules` into `ConditionClause[]` (generating fresh client-side
  `id`s via the existing `newActionId()`-style helper), returns
  `conditionClauses: ConditionClause[]` alongside the existing
  `triggerType`/`scheduleConfig`/`actions`. Existing callers (edit-mode fetch,
  template-seed hydration) both already destructure this function's return
  value with object destructuring, so adding a new field is additive — no call
  site breaks by not reading it, and both current call sites should be updated
  to also set `conditionClauses`.
- `serialize()` (lines 383–416) gains: `if (conditionClauses.length > 0) { nodes.push({ id: 'condition', type: 'condition', conditions: { operator: 'AND', rules: conditionClauses.map(c => ({ field: c.field, op: c.op, value: coerceValue(c) })) } }); }` — inserted into the `nodes` array **right after the trigger node, before the first action node**, with the edge chain (`edges = nodes.slice(1).map(...)`) unaffected since it already generically chains whatever's in `nodes` in array order. `coerceValue` converts the string UI value to `Number(...)` when the field's `kind === 'number'` (except `in`/`not_in`, which split into a string array regardless of kind, per 1.3a).

---

## TASK 2 — Wait/delay action (`flow.delay`) config UI

### 2.1 Friendly duration input

New component: **`DelayActionConfigPanel.tsx`**, in
`app/src/components/workflow-builder/sentence/` (same directory as the other
action-specific config panels, even though structurally it's closer to
`ScheduleTriggerConfigPanel.tsx`'s pattern — it's still an *action* config
panel, so it lives with its siblings, not in `panels/` which is reserved for
trigger config today; if Elias later adds more non-trigger structured
sub-panels, `panels/` can be generalized then, out of scope here).

```ts
export interface DelayConfigState {
  amount: number;                       // the number the user typed, in `unit`'s scale — e.g. 2
  unit: 'minutes' | 'hours' | 'days';    // display unit
}

export interface DelayActionConfigPanelProps {
  value: DelayConfigState;
  onChange: (value: DelayConfigState) => void;
}
```

Default value when `flow.delay` is first selected in the action tile grid:
`{ amount: 1, unit: 'hours' }` — matches the task brief's framing ("nobody
thinks in 4320 minutes") by defaulting to a unit customers actually reason in,
not raw minutes. (1 hour, not 1 minute — a 1-minute default delay is an
unusual real-world case and would read as a placeholder/mistake; 1 hour is the
median "wait a bit before escalating" duration and matches
`DEEP_AUDIT_UX_FINDINGS.md` §9's own example, "if unresolved after 24
hours.")

```tsx
export function DelayActionConfigPanel({ value, onChange }: DelayActionConfigPanelProps) {
  const { t } = useTranslation();
  const previewText = useMemo(() => buildDelayPreview(value, t), [value, t]);

  return (
    <div className="space-y-3" data-testid="delay-action-config-panel">
      <Label htmlFor="delay-amount">{t('workflows.builder.sentence.simpleForm.delayLabel')}</Label>
      <div className="flex items-center gap-2">
        <Input
          id="delay-amount"
          type="number"
          min={1}
          max={UNIT_MAX[value.unit]}
          className="w-24"
          value={value.amount}
          onChange={(e) => onChange({ ...value, amount: clampDelayAmount(Number(e.target.value) || 1, value.unit) })}
        />
        <Select value={value.unit} onValueChange={(u) => onChange({ ...value, unit: u as DelayConfigState['unit'], amount: clampDelayAmount(value.amount, u as DelayConfigState['unit']) })}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="minutes">{t('workflows.builder.sentence.simpleForm.delayUnitMinutes')}</SelectItem>
            <SelectItem value="hours">{t('workflows.builder.sentence.simpleForm.delayUnitHours')}</SelectItem>
            <SelectItem value="days">{t('workflows.builder.sentence.simpleForm.delayUnitDays')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Live preview — same "rounded-xl bg-muted/40 p-3" treatment as
          ScheduleTriggerConfigPanel's #schedule-preview block */}
      <div className="rounded-xl bg-muted/40 p-3" data-testid="delay-preview">
        <p className="text-sm font-semibold text-on-surface">{previewText}</p>
      </div>
    </div>
  );
}
```

- **Unit-aware clamping** (`clampDelayAmount`/`UNIT_MAX`), so the raw
  `delay_minutes` a customer can produce stays sane without a hard backend
  validation round-trip: `minutes` → 1–1440 (up to 24h expressed in minutes,
  beyond which they should switch to hours/days for readability); `hours` →
  1–720 (30 days); `days` → 1–90. These are soft UI guardrails, not engine
  limits — Priya's backend can enforce its own ceiling independently
  (flagged for her as an open cross-check, not assumed here).
- **Unit switch preserves intent, not the raw number** — switching from
  `hours: 2` to `minutes` should NOT silently become `minutes: 2` (a
  120x-smaller delay). `clampDelayAmount` on unit-change converts the
  underlying total first (`amount * unitToMinutes[oldUnit] / unitToMinutes[newUnit]`,
  rounded), so "2 hours" → switch to minutes → shows "120", not "2". This is a
  real correctness detail, not polish — the alternative silently and severely
  under-delays a workflow with zero error or warning.
- **Conversion to `delay_minutes` happens at serialize time, not on every
  keystroke** — `DelayConfigState` is the UI's own state shape (mirrors how
  `ScheduleConfigState` is a UI-only shape converted to `cron` via
  `buildCronFromConfig()` only when serializing). `WorkflowBuilderPage.tsx`'s
  `ActionState.simpleConfig` for a `flow.delay` action stores
  `{ delayUiState: DelayConfigState }` during editing (same
  `scheduleUiState` round-trip precedent `buildTriggerNodeConfig()` already
  uses for `time.schedule`, lines 372–377), and `serialize()` computes the
  real `delay_minutes` field into the persisted action config:
  ```ts
  function buildDelayNodeConfig(ui: DelayConfigState): Record<string, unknown> {
    const unitToMinutes = { minutes: 1, hours: 60, days: 1440 };
    return { delay_minutes: Math.round(ui.amount * unitToMinutes[ui.unit]), delayUiState: ui };
  }
  ```
  Persisting `delayUiState` alongside the computed `delay_minutes` (same
  pattern as `scheduleUiState` next to `cron`) is what lets `hydrateFromNodes()`
  restore the exact friendly amount/unit the customer originally chose on
  re-edit, instead of back-calculating "125 minutes" into an awkward
  "2.08 hours." Backend only needs to read `delay_minutes` — `delayUiState` is
  frontend-only round-trip convenience, exactly how `scheduleUiState` is
  already treated (never read by the engine, only by the builder).

### 2.2 Live preview copy — exact strings

**Pluralization note — confirmed, not hypothetical:** read `app/src/lib/i18n.ts`
directly — `t()`'s interpolation is a plain regex substitution
(`raw.replace(/\{(\w+)\}/g, ...)`), with **no ICU `plural` syntax support** in
this codebase's `i18n` lib. So the singular/plural choice must be made in code
via two literal keys per unit, not via a single ICU-style key:

```ts
function buildDelayPreview(v: DelayConfigState, t: TFunction): string {
  const key = `workflows.builder.sentence.simpleForm.delayUnit${capitalize(v.unit)}${v.amount === 1 ? 'One' : 'Other'}`;
  const unitLabel = t(key, { count: v.amount });
  return t('workflows.builder.sentence.simpleForm.delayPreview', { duration: unitLabel });
}
```

Locale additions (`en.ts`, inside `workflows.builder.sentence.simpleForm`):
```ts
delayLabel: 'Wait for',
delayUnitMinutes: 'Minutes',
delayUnitHours: 'Hours',
delayUnitDays: 'Days',
delayUnitMinutesOne: '{count} minute',
delayUnitMinutesOther: '{count} minutes',
delayUnitHoursOne: '{count} hour',
delayUnitHoursOther: '{count} hours',
delayUnitDaysOne: '{count} day',
delayUnitDaysOther: '{count} days',
delayPreview: 'Then wait {duration} before continuing.',
```
Exact preview line for the task's own example (2 hours): **"Then wait 2 hours
before continuing."** — matches the brief's requested copy verbatim.

### 2.3 Execution-order language — the pill-row problem, and my recommendation

**Recommendation: lightweight fix — ordinal-free, but a distinct visual
treatment + connective glyph for Flow-category actions. Do not add "1." "2."
"3." ordinal badges to every action pill this wave.**

Reasoning, working from the audit's own S-1 finding and this wave's explicit
incremental-scope framing:

- **Full ordinal badges on every pill is the "solve it for every combination"
  trap the task explicitly told me to avoid.** Numbering every pill 1/2/3/...
  is simple to describe but has real second-order UI cost: `ActionClauseList`
  is drag-reorderable (`dnd-kit`), so ordinals would need to live-renumber on
  every drag — meaning `SortableClause` needs to know its own array index
  (currently it doesn't; only `ActionClauseList`'s parent map does), a
  moderate refactor of a component that's currently index-agnostic by design.
  That's disproportionate for what this wave actually needs, which is just:
  make it unambiguous that `flow.delay` (and `flow.approval`/`flow.stop`)
  pause the whole chain at their position, vs. regular actions which don't.
- **What actually causes the customer confusion isn't missing numbers — it's
  that Flow actions look identical to Notify/Data/Integration actions.** All
  action pills today render through the same undifferentiated
  `SortableClause` markup (`bg-primary/10 text-primary`, `ActionClauseList.tsx`
  lines 65–70) regardless of category. A customer scanning "Notify Slack ×
  Wait 2 hours × Create Jira ticket ×" has no visual cue that the middle one
  is qualitatively different (a control-flow pause, not a side-effecting
  action) — that's the real gap, and it's fixable with a style change to one
  component, not a data-model change.

**The fix:** give `category: 'Flow'` action clauses (`flow.approval`,
`flow.stop`, `flow.delay`) a **distinct pill treatment inside
`ActionClauseList`/`SortableClause`** — amber/warning-tinted with a small
"pause"-style icon prefix, instead of the default primary-tinted pill every
other action gets. This requires `ActionClause` (currently `{ id, action,
label }`) to also carry `category: string` so `SortableClause` can branch on
it without a second registry lookup inside the list component:

```ts
// ActionClauseList.tsx
export interface ActionClause {
  id: string;
  action: string;
  label: string;
  category: string;  // NEW — 'Notify' | 'Data' | 'Crystal' | 'Integration' | 'Flow'
}
```
`WorkflowBuilderPage.tsx`'s `actionClauses` memo (line 359) already has
`actionDefs` in scope to resolve this from — trivial additive change:
```ts
const actionClauses: ActionClause[] = actions.map((a) => ({
  id: a.id, action: a.action, label: actionLabel(a.action),
  category: actionDefs.find((d) => d.action === a.action)?.category ?? '',
}));
```

```tsx
// SortableClause — additive branch, not a rewrite
const isFlow = clause.category === 'Flow';
<span className={cn(
  'inline-flex items-center gap-1 rounded-full pl-1 pr-2 py-1 text-sm font-semibold',
  isFlow ? 'bg-warning/10 text-warning' : 'bg-primary/10 text-primary',
)}>
  {isFlow && <Icon name="pause_circle" size={13} className="opacity-80" />}
  {/* ...existing drag handle / label button / remove button, unchanged... */}
</span>
```

Plus one connective micro-copy change: when a Flow action is followed by more
actions in the list, render a short static caption **once**, directly under
the sentence row (not per-pill, not a live-updating computed string) —

> *Actions before a pause run immediately; actions after resume only once the
> pause clears.*

— shown via a small `<p className="text-xs text-on-surface-variant mt-1">`
directly under the existing `helperText` line in `WorkflowBuilderPage.tsx`,
**conditionally rendered only when `actions.some(a => actionDefs.find(d =>
d.action === a.action)?.category === 'Flow')`** — i.e., invisible for the
common case (no Flow action at all) and appears as one fixed sentence, not a
per-position computed narrative, the moment any Flow action (approval, stop,
or the new delay) is added. This directly answers "does a customer need to
know delay happens before/after specific other actions" without building
per-pair sequencing UI — array order (drag-to-reorder, already supported)
remains the single source of truth for order; this caption just tells the
customer that order is now execution-meaningful, once a pause exists.

**Locale additions:**
```ts
// workflows.builder.sentence.actionClause
flowOrderHint: 'Actions before a pause run immediately; actions after resume only once the pause clears.',
```

**Explicitly deferred (do not build this wave):** per-pill ordinal numbering,
live "runs at T+2h" timestamps per action, branching/parallel execution
visualization, and any treatment of multiple Flow actions interacting with
each other (e.g. two delays in sequence) beyond what array order + the static
caption already communicate. If a future wave adds real branching to the
sentence builder (not just the canvas), execution-order communication should
be redesigned holistically then — this fix is scoped tightly to "one new
pausing action type is entering a flat pill list that had no pause-awareness
at all before."

### 2.4 Action-type picker placement and icon

- **Category: confirmed `'Flow'`, alongside `flow.approval`/`flow.stop`.**
  `backend/src/lib/workflowRegistry.ts`'s `ACTIONS` array gets one new entry
  (Priya's registry PR, not this doc's to author, but the frontend contract
  is worth stating so Elias can validate Priya's entry matches):
  ```ts
  { action: 'flow.delay', category: 'Flow', label: 'Wait / delay', live: true },
  ```
  `ActionStepPanelContent.tsx`'s `CATEGORY_ORDER` (`['Notify', 'Data',
  'Crystal', 'Integration', 'Flow']`) already puts `Flow` last — no change
  needed there; the new tile just appears in the existing "Flow" group
  alongside "Require approval" and "Stop workflow", picked up automatically
  once the registry entry exists (the tile grid iterates `actions.filter((a)
  => a.category === category)` generically, `ActionStepPanelContent.tsx` line
  67).
- **Distinct icon: yes, recommended, but at the `ActionTile` level this
  requires a small additive change since `ActionTile.tsx` currently renders
  no per-action icon at all** (confirmed — it's label + readiness dot only,
  no icon prop exists today, for any action, in any category). Adding icons
  for one action type only (`flow.delay`) while every other of the 13 actions
  stays icon-less would look unfinished/arbitrary. **Recommendation: defer a
  general action-tile icon system to a future wave** (it's a bigger, all-13-actions
  change, not scoped to this wave's "very safe/incremental" ask) — for *this*
  wave, `flow.delay` gets the same plain-label tile every other action gets,
  with the visual distinction happening downstream, in the resting sentence's
  `ActionClauseList` pill (2.3's amber pause-icon treatment) and inside its
  own step-panel via `DelayActionConfigPanel`'s clear "Wait for [N] [unit]"
  heading. The picker-tile level doesn't need a new icon to solve the
  customer confusion this wave is scoped to fix — the confusion the task
  describes is about the resting sentence being unreadable with a pause mixed
  in, not about finding `flow.delay` in the tile grid (which already has a
  self-explanatory label, "Wait / delay").
- **Config-form dispatch:** `ActionStepPanelContent.tsx`'s three-way branch
  (`isContentProducing` / `isInAppNotify` / else `SimpleActionConfigForm`)
  needs a fourth branch for `flow.delay`, since `DelayActionConfigPanel` is
  its own structured component, not a `SimpleActionConfigForm` field list:
  ```tsx
  const isDelay = selectedAction === 'flow.delay';
  // ...
  ) : isDelay ? (
    <DelayActionConfigPanel
      value={(contentConfig as unknown as { delayUiState?: DelayConfigState }).delayUiState ?? { amount: 1, unit: 'hours' }}
      onChange={(delayUiState) => onSimpleConfigChange({ ...simpleConfig, delayUiState })}
    />
  ) : (
    <SimpleActionConfigForm ... />
  )
  ```
  Uses `simpleConfig`/`onSimpleConfigChange` (not `contentConfig`) since
  `flow.delay` is not a `CONTENT_PRODUCING_ACTION` and has no sections/preset
  — same bucket `flow.approval`/`flow.stop`/`jira.create_issue` etc. already
  live in via `ActionState.simpleConfig`. `hydrateFromNodes()` needs the
  mirror-image read: when `n.action === 'flow.delay'`, populate
  `simpleConfig: { delayUiState: cfg.delayUiState ?? minutesToUiState(cfg.delay_minutes) }`
  — the `minutesToUiState` fallback covers the edge case of a `flow.delay`
  node created some other way (e.g. directly via API, or a future canvas
  builder support) that has `delay_minutes` but no `delayUiState`, so editing
  it in the sentence builder doesn't crash or silently show "1 hour" for an
  actual 47-minute delay.

---

## Summary of every additive change Elias needs to make (checklist form)

**Task 1 (condition step):**
1. `SentencePill.tsx` — add `'condition'` to `SentencePillState`, add optional `icon` prop. Additive, no existing state renamed.
2. New `ConditionStepPanelContent.tsx` (sentence/) — field/operator/value row(s), `+ add another condition`.
3. `WorkflowBuilderPage.tsx` — new `conditionClauses` state, new `'condition'` `StepId` member, new pill + `StepPanel` block between scope and action, `conditionFields`/`conditionOperators` destructured from the existing registry fetch, `hydrateFromNodes()` extended (4th return field), `serialize()` extended (conditionally pushes one condition node).
4. Locale keys under `workflows.builder.sentence.condition.*` and one new `pill.pickCondition`/`pill.conditionCount` pair.
5. **Regression test (Elias, required, not optional):** zero-condition save produces byte-identical `nodes`/`edges` to pre-Wave-11 behavior.

**Task 2 (`flow.delay`):**
1. Backend registry entry `{ action: 'flow.delay', category: 'Flow', label: 'Wait / delay', live: true }` — Priya's, cross-check only.
2. New `DelayActionConfigPanel.tsx` (sentence/) — amount input + unit select + live preview line.
3. `ActionStepPanelContent.tsx` — new `isDelay` branch dispatching to `DelayActionConfigPanel`.
4. `ActionClauseList.tsx` — `ActionClause` gains `category`; `SortableClause` gets an additive amber/pause-icon branch for `category === 'Flow'`.
5. `WorkflowBuilderPage.tsx` — `actionClauses` memo passes `category`; new conditional flow-order hint caption under the sentence; `serialize()`/`hydrateFromNodes()` round-trip `delayUiState` ↔ `delay_minutes`.
6. Locale keys under `workflows.builder.sentence.simpleForm.delay*` and `workflows.builder.sentence.actionClause.flowOrderHint`.

**Explicitly out of scope this wave (noted, not silently dropped):** `between`/`in`/`not_in` operators' richer input UIs, OR-logic condition groups, per-pill ordinal execution-order badges, a general action-tile icon system, and canvas-builder support for `flow.delay` (canvas already gets `flow.delay` "for free" once the registry entry exists — its generic `ActionNode` select/`isActionConfigured` pattern picks up any new action automatically — but a canvas-specific `DelayActionConfigPanel` equivalent inside `ActionConfigPanel.tsx` is a separate, smaller follow-up not required for this wave's sentence-builder-focused ask).
