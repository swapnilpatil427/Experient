// Cross-wave interaction audit (Priya, 2026-07-03). Every prior verification
// pass checked Wave 11's primitives (flow.delay pause/resume, tier gating,
// optimistic-locking, audit trail) in isolation. This file specifically tests
// what happens when those primitives are exercised IN COMBINATION — a
// plan-downgrade during an in-flight flow.delay pause, and a workflow edit
// (which bumps `version` + rewrites `nodes`) landing while an execution is
// mid-pause and waiting to resume against the OLD node/edge graph.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const DB_PATH       = _require.resolve(resolve(__dirname, '../lib/db'));
const NOTIF_PATH    = _require.resolve(resolve(__dirname, '../lib/notifications'));
const CH_PATH       = _require.resolve(resolve(__dirname, '../lib/channels'));
const MOD_PATH      = _require.resolve(resolve(__dirname, '../lib/workflowEngine'));
const CREDS_PATH    = _require.resolve(resolve(__dirname, '../lib/workflowCredentials'));
const CONN_PATH     = _require.resolve(resolve(__dirname, '../lib/connectors'));
const PLANGATE_PATH = _require.resolve(resolve(__dirname, '../lib/planGating'));

let dbQuery, createNotificationMock, sendSlackMock, sendEmailMock;
function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }
function load() {
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[NOTIF_PATH] = fakeMod(NOTIF_PATH, { createNotification: createNotificationMock, serialize: (r) => r });
  _require.cache[CH_PATH] = fakeMod(CH_PATH, { sendSlack: sendSlackMock, sendEmail: sendEmailMock });
  // planGating.ts/connectors.ts/workflowCredentials.ts close over `./db` at
  // require-time — evict them every load() so they pick up the CURRENT
  // dbQuery mock (same pattern as workflowEngine.test.js).
  delete _require.cache[CONN_PATH];
  delete _require.cache[CREDS_PATH];
  delete _require.cache[PLANGATE_PATH];
  delete _require.cache[MOD_PATH];
  return _require(MOD_PATH);
}

beforeEach(() => {
  dbQuery = vi.fn(async (text) => {
    if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
    return { rows: [] };
  });
  createNotificationMock = vi.fn(async () => ({ id: 'n1' }));
  sendSlackMock = vi.fn(async () => ({ channel: 'slack', delivered: true }));
  sendEmailMock = vi.fn(async () => ({ channel: 'email', delivered: true }));
});

// ── Hypothesis 1: does a RESUMED execution re-check tier gating? ───────────
//
// Scenario: an org on Growth creates a workflow triggered by
// crystal.anomaly_detected (Growth-gated), containing a flow.delay step. The
// trigger fires validly while the org is still on Growth (runWorkflow's
// tier-gate check passes, the workflow pauses on flow.delay). The org then
// downgrades to Free during the delay window. When resumeDelayedExecution
// picks the row up, does the downstream action fire anyway?
//
// Argument for why this SHOULD gate: planGating.ts's own header comment
// states the precedent (lib/seats.ts::checkSeatLimit) is that a downgrade
// takes effect immediately, "not just on the next save" — and specifically
// says the execution-time check exists so an already-saved workflow "should
// have that workflow stop firing on the very next trigger." A resume is
// still part of firing the SAME logical execution that was gated at trigger
// time — the org's current entitlement, not its entitlement 24h ago, should
// govern whether the downstream action (the actual customer-visible/billable
// behavior the tier gate protects) is allowed to run.
describe('CROSS-WAVE: plan-tier gating vs. flow.delay resume (Wave 10 gating x Wave 11 delay)', () => {
  const delayGatedWf = {
    id: 'w-gated', org_id: 'o1', trigger_type: 'crystal.anomaly_detected',
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'd', type: 'action', action: 'flow.delay', config: { delay_minutes: 1440 } },
      { id: 'a1', type: 'action', action: 'notify.in_app', config: { title: 'Anomaly follow-up', userIds: ['u1'] } },
    ],
  };

  it('runWorkflow correctly gates the INITIAL trigger on a sub-Growth plan (control case)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('plan_tier FROM org_profiles')) return { rows: [{ plan_tier: 'free' }] };
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-gated' }] };
      return { rows: [] };
    });
    const { runWorkflow } = load();
    const r = await runWorkflow(delayGatedWf, { type: 'crystal.anomaly_detected' }, { orgId: 'o1' });
    expect(r.status).toBe('skipped');
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it('runWorkflow lets the trigger through on Growth and correctly pauses at flow.delay (sets up the scenario)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('plan_tier FROM org_profiles')) return { rows: [{ plan_tier: 'growth' }] };
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      return { rows: [] };
    });
    const { runWorkflow } = load();
    const r = await runWorkflow(delayGatedWf, { type: 'crystal.anomaly_detected' }, { orgId: 'o1' });
    expect(r.status).toBe('waiting');
    expect(createNotificationMock).not.toHaveBeenCalled(); // action not yet run, correctly paused
  });

  // THE GAP (found, fixed): org downgraded to Free during the 24h delay
  // window. resumeDelayedExecution used to go straight from the atomic claim
  // to runNodes/runGraph with no tier check at all, so the gated downstream
  // action fired anyway on a now-sub-Growth org — contradicting the
  // "downgrade takes effect immediately... at execution time" design intent
  // documented in planGating.ts (a resume is still the SAME logical
  // execution firing its action; the org's CURRENT entitlement, not its
  // entitlement hours/days ago, must govern it). Fixed via
  // reCheckTierGateOnResume(), called by both resumeWorkflow and
  // resumeDelayedExecution before resuming node/graph execution.
  it('FIXED (was BUG): resumeDelayedExecution re-checks tier gating — a downgraded org\'s gated workflow no longer fires its action after the delay', async () => {
    dbQuery = vi.fn(async (text) => {
      // Org is now on Free — if the gate were re-checked, this must block.
      if (text.includes('plan_tier FROM org_profiles')) return { rows: [{ plan_tier: 'free' }] };
      if (text.includes('RETURNING *')) {
        // The atomic claim UPDATE — row was validly paused while still on Growth.
        return { rows: [{ id: 'exec-1', org_id: 'o1', workflow_id: 'w-gated', resume_index: 2, trigger_payload: { type: 'crystal.anomaly_detected' } }] };
      }
      if (text.includes('FROM workflows')) return { rows: [delayGatedWf] };
      return { rows: [] };
    });
    const { resumeDelayedExecution } = load();
    const r = await resumeDelayedExecution('exec-1');
    // Fixed behavior: the resume must observe the org is no longer entitled
    // and must NOT run the downstream notify.in_app action.
    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(r.status).toBe('skipped');
  });

  it('FIXED (was BUG, human-approval variant): resumeWorkflow re-checks tier gating — a downgraded org\'s gated workflow no longer fires after human approval', async () => {
    const approvalGatedWf = {
      id: 'w-gated-appr', org_id: 'o1', trigger_type: 'crystal.sentiment_spike',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'appr', type: 'action', action: 'flow.approval' },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: { title: 'Sentiment follow-up', userIds: ['u1'] } },
      ],
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('plan_tier FROM org_profiles')) return { rows: [{ plan_tier: 'free' }] };
      if (text.includes('FROM workflow_executions')) {
        return { rows: [{ id: 'exec-2', workflow_id: 'w-gated-appr', resume_index: 2, trigger_payload: { type: 'crystal.sentiment_spike' } }] };
      }
      if (text.includes('FROM workflows')) return { rows: [approvalGatedWf] };
      return { rows: [] };
    });
    const { resumeWorkflow } = load();
    const r = await resumeWorkflow('exec-2', 'o1', 'approved', 'admin');
    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(r.status).toBe('skipped');
  });

  it('control: resume still runs the action normally when the org remains entitled (no false-positive block)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('plan_tier FROM org_profiles')) return { rows: [{ plan_tier: 'growth' }] };
      if (text.includes('RETURNING *')) {
        return { rows: [{ id: 'exec-1', org_id: 'o1', workflow_id: 'w-gated', resume_index: 2, trigger_payload: { type: 'crystal.anomaly_detected' } }] };
      }
      if (text.includes('FROM workflows')) return { rows: [delayGatedWf] };
      return { rows: [] };
    });
    const { resumeDelayedExecution } = load();
    const r = await resumeDelayedExecution('exec-1');
    expect(createNotificationMock).toHaveBeenCalled();
    expect(r.status).toBe('completed');
  });

  it('control: an ungated trigger type resumes without ever consulting plan_tier', async () => {
    const ungatedDelayWf = {
      id: 'w-ungated', org_id: 'o1', trigger_type: 'alert.fired',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'd', type: 'action', action: 'flow.delay', config: { delay_minutes: 5 } },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: { title: 'Alert follow-up', userIds: ['u1'] } },
      ],
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('RETURNING *')) {
        return { rows: [{ id: 'exec-3', org_id: 'o1', workflow_id: 'w-ungated', resume_index: 2, trigger_payload: { type: 'alert.fired' } }] };
      }
      if (text.includes('FROM workflows')) return { rows: [ungatedDelayWf] };
      return { rows: [] };
    });
    const { resumeDelayedExecution } = load();
    const r = await resumeDelayedExecution('exec-3');
    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalled();
    expect(dbQuery.mock.calls.some(([sql]) => sql.includes('plan_tier'))).toBe(false);
  });
});

// ── Hypothesis 2: pause-time snapshot vs. a mid-pause workflow edit ────────
//
// Scenario: a workflow is paused (status='waiting', resume_index/
// resume_node_id captured against the node/edge graph that was live AT PAUSE
// TIME). A user opens the SAME workflow in the builder and edits it (e.g.
// changes/removes an action), which increments `workflows.version` and
// REWRITES `workflows.nodes`/`edges`.
//
// WAVE 16 FINDING (documented, not fixed pending a product decision):
// resumeWorkflow/resumeDelayedExecution used to re-fetch
// `SELECT * FROM workflows WHERE id = $1` fresh at resume time — so they ran
// against the NEW graph using resume_index/resume_node_id that were computed
// against the OLD graph shape. This could misfire onto the wrong node, or
// silently no-op, if the node at that index changed meaning or the node id
// no longer existed.
//
// WAVE 17 FIX (user's explicit decision: "snapshot the exact graph at pause
// time and always run that regardless of later edits"): persistPause() now
// writes `snapshot_nodes`/`snapshot_edges`/`snapshot_trigger_type` at the
// moment of pause, and resumeWorkflow/resumeDelayedExecution read those
// columns back instead of the live `workflows` row whenever a snapshot is
// present (see resolveResumeGraphSource in workflowEngine.ts). The 3 tests
// below prove the fix directly: each scenario is IDENTICAL to its Wave 16
// "DOCUMENTS REAL GAP" predecessor (same edit, same resume) except the mocked
// `workflow_executions` row now carries the pause-time snapshot — and the
// assertion flips to prove the ORIGINAL action/graph runs, not the edited one.
describe('CROSS-WAVE: pause-time snapshot vs. an in-flight paused execution (Wave 17 fix for the Wave 16 stale-graph-on-resume gap)', () => {
  it('FIXED (was BUG): resumeWorkflow runs the SNAPSHOTTED action from pause time, not an action added by a later edit at the same index', async () => {
    // At pause time, the graph was: [trigger, approval, notify.in_app(u1)] —
    // resume_index=2 pointed at the notify.in_app node. persistPause snapshot
    // this exact graph onto the execution row.
    const originalNotifyIndex = 2;
    const snapshotNodes = [
      { id: 't', type: 'trigger' },
      { id: 'appr', type: 'action', action: 'flow.approval' },
      { id: 'a1', type: 'action', action: 'notify.in_app', config: { title: 'Go', userIds: ['u1'] } },
    ];
    // While paused, the user edits the workflow in the builder: they REMOVE
    // the notify.in_app action and add a jira.create_issue action instead, in
    // the SAME index position ("let's route this to Jira instead"). This is a
    // completely realistic edit — but per the snapshot semantic, it must have
    // NO effect on this already-paused execution's resume.
    const editedWorkflowRow = {
      id: 'w1', org_id: 'o1', version: 2, // bumped by the PUT that made this edit
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'appr', type: 'action', action: 'flow.approval' },
        { id: 'a1', type: 'action', action: 'jira.create_issue', config: { project: 'OPS' } },
      ],
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions')) {
        return {
          rows: [{
            id: 'exec-1', workflow_id: 'w1', resume_index: originalNotifyIndex, trigger_payload: { userId: 'u1' },
            snapshot_nodes: snapshotNodes, snapshot_edges: [], snapshot_trigger_type: null,
          }],
        };
      }
      if (text.includes('FROM workflows')) return { rows: [editedWorkflowRow] }; // the EDITED live row — must be ignored
      return { rows: [] };
    });
    const { resumeWorkflow } = load();
    const r = await resumeWorkflow('exec-1', 'o1', 'approved', 'admin');
    // Fixed behavior: the resume runs the ORIGINAL snapshotted action
    // (notify.in_app) — exactly what the human approver saw/expected when
    // they approved — regardless of the later edit to the live row.
    expect(createNotificationMock).toHaveBeenCalled();
    expect(r.status).toBe('completed');
  });

  it('FIXED (was BUG): an edit that shortens the LIVE node array no longer matters — resume_index is checked against the SNAPSHOT\'s node count', async () => {
    // Original (snapshotted) graph had 3 nodes; resume_index=2 pointed at the
    // trailing notify.in_app action within the snapshot.
    const snapshotNodes = [
      { id: 't', type: 'trigger' },
      { id: 'appr', type: 'action', action: 'flow.approval' },
      { id: 'a1', type: 'action', action: 'notify.in_app', config: { title: 'Go', userIds: ['u1'] } },
    ];
    // The LIVE row was edited while paused: the trailing action was deleted,
    // so the live array now has only 2 nodes — resume_index=2 would be out of
    // bounds against THIS array. Under the old (buggy) behavior this produced
    // a silent no-op; under the snapshot semantic it's irrelevant, since the
    // live row's nodes are never consulted for a snapshotted execution.
    const shortenedWorkflowRow = {
      id: 'w2', org_id: 'o1', version: 3,
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'appr', type: 'action', action: 'flow.approval' },
      ],
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions')) {
        return {
          rows: [{
            id: 'exec-2', workflow_id: 'w2', resume_index: 2, trigger_payload: { userId: 'u1' },
            snapshot_nodes: snapshotNodes, snapshot_edges: [], snapshot_trigger_type: null,
          }],
        };
      }
      if (text.includes('FROM workflows')) return { rows: [shortenedWorkflowRow] };
      return { rows: [] };
    });
    const { resumeWorkflow } = load();
    const r = await resumeWorkflow('exec-2', 'o1', 'approved', 'admin');
    // Fixed behavior: resume_index=2 is valid against the 3-node SNAPSHOT, so
    // the notify.in_app action correctly runs — no silent no-op.
    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalled();
  });

  it('FIXED (was BUG, graph/branching mode): resume_node_id from the snapshot resolves correctly even though that node id no longer exists in the edited live graph', async () => {
    // At pause time (graph/branching workflow), resume_node_id pointed at
    // node 'after', which existed in the SNAPSHOTTED graph.
    const snapshotNodes = [
      { id: 't', type: 'trigger' },
      { id: 'appr', type: 'action', action: 'flow.approval' },
      { id: 'after', type: 'action', action: 'notify.in_app', config: { title: 'Go', userIds: ['u1'] } },
    ];
    const snapshotEdges = [
      { from: 't', to: 'appr', branch: 'true' }, // marks graph mode
      { from: 'appr', to: 'after' },
    ];
    // While paused, the user deletes/renames that action node and rewires the
    // canvas — 'after' no longer exists in the LIVE graph.
    const editedGraphWorkflowRow = {
      id: 'w3', org_id: 'o1', version: 2,
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'appr', type: 'action', action: 'flow.approval' },
        { id: 'after-renamed', type: 'action', action: 'notify.in_app', config: { title: 'Go', userIds: ['u1'] } },
      ],
      edges: [
        { from: 't', to: 'appr', branch: 'true' },
        { from: 'appr', to: 'after-renamed' },
      ],
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions')) {
        return {
          rows: [{
            id: 'exec-3', workflow_id: 'w3', resume_node_id: 'after', trigger_payload: {},
            snapshot_nodes: snapshotNodes, snapshot_edges: snapshotEdges, snapshot_trigger_type: null,
          }],
        };
      }
      if (text.includes('FROM workflows')) return { rows: [editedGraphWorkflowRow] }; // must be ignored
      return { rows: [] };
    });
    const { resumeWorkflow } = load();
    const r = await resumeWorkflow('exec-3', 'o1', 'approved', 'admin');
    // Fixed behavior: byId.get('after') resolves against the SNAPSHOT (where
    // 'after' still exists), so the notify.in_app action correctly runs —
    // no silent short-circuit.
    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
  });
});

// ── Hypothesis 2b: backward compatibility for pre-migration paused rows ────
//
// A `workflow_executions` row that was already sitting in status='waiting'
// BEFORE the Wave 17 migration landed has no snapshot at all (`snapshot_nodes
// IS NULL` — the detection signal). These legacy rows must not crash or
// misbehave on resume: they fall back to exactly the pre-Wave-17 behavior
// (fresh live-fetch from `workflows`), which is the closest available
// approximation for a pause that predates snapshotting.
describe('CROSS-WAVE: backward compatibility — a pre-migration paused execution with NULL snapshot columns still resumes via the live workflows row', () => {
  it('resumeWorkflow falls back to the live workflows row when snapshot_nodes is NULL (legacy pre-migration pause)', async () => {
    const liveWorkflowRow = {
      id: 'w-legacy', org_id: 'o1', version: 1,
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'appr', type: 'action', action: 'flow.approval' },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: { title: 'Go', userIds: ['u1'] } },
      ],
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions')) {
        // Legacy row: paused before this migration, so every snapshot column
        // is NULL/undefined — exactly what a real pre-migration row looks
        // like after the additive ALTER TABLE.
        return {
          rows: [{
            id: 'exec-legacy', workflow_id: 'w-legacy', resume_index: 2, trigger_payload: { userId: 'u1' },
            snapshot_nodes: null, snapshot_edges: null, snapshot_trigger_type: null,
          }],
        };
      }
      if (text.includes('FROM workflows')) return { rows: [liveWorkflowRow] };
      return { rows: [] };
    });
    const { resumeWorkflow } = load();
    const r = await resumeWorkflow('exec-legacy', 'o1', 'approved', 'admin');
    // No crash, and the action resolved from the live row's nodes runs
    // correctly — identical to today's pre-Wave-17 behavior for this case.
    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalled();
  });

  it('resumeDelayedExecution falls back to the live workflows row when snapshot_nodes is NULL (legacy pre-migration pause)', async () => {
    const liveWorkflowRow = {
      id: 'w-legacy-delay', org_id: 'o1', trigger_type: 'alert.fired',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'd', type: 'action', action: 'flow.delay', config: { delay_minutes: 5 } },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: { title: 'Go', userIds: ['u1'] } },
      ],
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('RETURNING *')) {
        return {
          rows: [{
            id: 'exec-legacy-2', org_id: 'o1', workflow_id: 'w-legacy-delay', resume_index: 2, trigger_payload: {},
            snapshot_nodes: null, snapshot_edges: null, snapshot_trigger_type: null,
          }],
        };
      }
      if (text.includes('FROM workflows')) return { rows: [liveWorkflowRow] };
      return { rows: [] };
    });
    const { resumeDelayedExecution } = load();
    const r = await resumeDelayedExecution('exec-legacy-2');
    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalled();
    // Confirms no tier-gate query blew up trying to read a snapshot trigger
    // type that doesn't exist on this legacy row — it fell back to the live
    // row's trigger_type ('alert.fired', ungated) with zero errors.
  });
});

// ── Hypothesis 2c: the tier-gate re-check (Wave 16) must use the SNAPSHOTTED
// trigger_type on resume, not the live row's — consistent with "ignores the
// edit" ────────────────────────────────────────────────────────────────────
//
// Wave 16 added reCheckTierGateOnResume() so a plan downgrade during a pause
// window is enforced immediately. Wave 17's snapshot semantic means that
// check must apply to the trigger type that was ACTUALLY firing when the
// workflow paused — not whatever the workflow's trigger has since been
// edited to. If someone changes a workflow's trigger type entirely while
// it's paused, the tier check on resume should still reflect the ORIGINAL
// (snapshotted) trigger type.
describe('CROSS-WAVE: tier-gate re-check on resume uses the SNAPSHOTTED trigger_type, not the live row\'s (Wave 16 x Wave 17)', () => {
  it('a workflow whose trigger_type is changed to a Growth-gated type WHILE PAUSED does not retroactively gate a resume snapshotted under the original ungated trigger', async () => {
    // At pause time, trigger_type was 'alert.fired' (ungated) — snapshotted
    // onto the execution row.
    const snapshotNodes = [
      { id: 't', type: 'trigger' },
      { id: 'd', type: 'action', action: 'flow.delay', config: { delay_minutes: 60 } },
      { id: 'a1', type: 'action', action: 'notify.in_app', config: { title: 'Go', userIds: ['u1'] } },
    ];
    // While paused, the user edits the workflow's trigger to a Growth-gated
    // type — an even more drastic edit than changing an action. Org is on
    // Free. If the tier check consulted the LIVE row's trigger_type, this
    // resume would incorrectly get gated/skipped despite having been fired
    // under, and snapshotted against, an ungated trigger.
    const editedWorkflowRow = {
      id: 'w-retrigger', org_id: 'o1', trigger_type: 'crystal.anomaly_detected',
      nodes: snapshotNodes,
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('plan_tier FROM org_profiles')) return { rows: [{ plan_tier: 'free' }] };
      if (text.includes('RETURNING *')) {
        return {
          rows: [{
            id: 'exec-retrigger', org_id: 'o1', workflow_id: 'w-retrigger', resume_index: 2, trigger_payload: {},
            snapshot_nodes: snapshotNodes, snapshot_edges: [], snapshot_trigger_type: 'alert.fired',
          }],
        };
      }
      if (text.includes('FROM workflows')) return { rows: [editedWorkflowRow] };
      return { rows: [] };
    });
    const { resumeDelayedExecution } = load();
    const r = await resumeDelayedExecution('exec-retrigger');
    // Fixed/consistent behavior: the tier check used the SNAPSHOTTED
    // 'alert.fired' (ungated), so the resume proceeds and the action runs —
    // the live row's edited-to-Growth-gated trigger_type never enters into it.
    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalled();
  });

  it('control: a workflow whose trigger_type is changed to an UNGATED type while paused does not spuriously unblock a resume snapshotted under the original Growth-gated trigger', async () => {
    // At pause time, trigger_type was 'crystal.anomaly_detected' (Growth-gated)
    // — snapshotted onto the execution row. Org is on Free.
    const snapshotNodes = [
      { id: 't', type: 'trigger' },
      { id: 'd', type: 'action', action: 'flow.delay', config: { delay_minutes: 60 } },
      { id: 'a1', type: 'action', action: 'notify.in_app', config: { title: 'Go', userIds: ['u1'] } },
    ];
    // While paused, the user edits the workflow's trigger to an ungated type.
    // If the tier check consulted the LIVE row, this resume would incorrectly
    // be let through despite having paused under a gated trigger on a
    // since-downgraded org.
    const editedWorkflowRow = {
      id: 'w-retrigger-2', org_id: 'o1', trigger_type: 'alert.fired',
      nodes: snapshotNodes,
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('plan_tier FROM org_profiles')) return { rows: [{ plan_tier: 'free' }] };
      if (text.includes('RETURNING *')) {
        return {
          rows: [{
            id: 'exec-retrigger-2', org_id: 'o1', workflow_id: 'w-retrigger-2', resume_index: 2, trigger_payload: {},
            snapshot_nodes: snapshotNodes, snapshot_edges: [], snapshot_trigger_type: 'crystal.anomaly_detected',
          }],
        };
      }
      if (text.includes('FROM workflows')) return { rows: [editedWorkflowRow] };
      return { rows: [] };
    });
    const { resumeDelayedExecution } = load();
    const r = await resumeDelayedExecution('exec-retrigger-2');
    // Consistent behavior: the tier check used the SNAPSHOTTED
    // 'crystal.anomaly_detected' (Growth-gated), so a Free org is correctly
    // blocked — the live row's edited-to-ungated trigger_type never masks it.
    expect(r.status).toBe('skipped');
    expect(createNotificationMock).not.toHaveBeenCalled();
  });
});

// ── Hypothesis 3: audit-trail attribution after a Crystal-applied proposal ──
//
// Verified SAFE by direct code read across both layers, documented here as a
// permanent regression rather than an untested assumption:
//   - app/src/pages/WorkflowCanvasPage.tsx's hydrateFromProposal() (the Wave
//     14 builderDraftHydrator) only calls setNodes/setEdges/setName — plain
//     React state setters. It makes zero API calls and never touches
//     workflows.updated_by or workflow_audit_log.
//   - The eventual persist is the SAME, unmodified Save button flow
//     (api.createGraphWorkflow / api.updateGraphWorkflow) regardless of
//     whether the draft was hand-typed or Crystal-hydrated.
//   - routes/workflows.ts's PUT handler unconditionally stamps
//     `updated_by = req.userId` (the authenticated human who issued the
//     HTTP request) and writes the audit-log row with
//     `actorUserId: req.userId` — there is no "actorUserId: 'crystal'" or
//     equivalent code path anywhere in this file.
// This test proves the backend half of that claim: the PUT handler's audit
// attribution is identical regardless of what produced the request body,
// because there both is no field and no code path to distinguish a
// Crystal-hydrated save from a manual one at this layer.
describe('CROSS-WAVE: audit-trail attribution after a Crystal-hydrated builder save (Wave 11 audit trail x Wave 14 hydrator) — verified SAFE', () => {
  it('PUT /api/workflows/:id always attributes updated_by/audit actorUserId to the authenticated request user, never to "crystal" or any other synthetic actor', async () => {
    const _requireLocal = createRequire(import.meta.url);
    const AUTH_PATH = _requireLocal.resolve(resolve(__dirname, '../middleware/auth'));
    const PERM_PATH = _requireLocal.resolve(resolve(__dirname, '../middleware/requirePermission'));
    const AUDIT_PATH = _requireLocal.resolve(resolve(__dirname, '../lib/workflowAuditLog'));
    const ROUTER_PATH = _requireLocal.resolve(resolve(__dirname, '../routes/workflows'));
    const inject = (await import('light-my-request')).default;
    const express = (await import('express')).default;

    const auditWrites = [];
    const existingRow = { id: 'w1', org_id: 'o1', name: 'Old name', version: 1, nodes: [], edges: [] };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT * FROM workflows WHERE id')) return { rows: [existingRow] };
      if (text.startsWith('UPDATE workflows SET')) return { rows: [{ ...existingRow, version: 2 }] };
      return { rows: [] };
    });

    _requireLocal.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
      // Simulates a real human (not Crystal) issuing the HTTP request that
      // follows clicking Save after applying a Crystal proposal.
      requireAuth: (req, res, next) => { req.orgId = 'o1'; req.userId = 'human-user-42'; next(); },
    });
    _requireLocal.cache[PERM_PATH] = fakeMod(PERM_PATH, {
      requirePermission: () => (req, res, next) => next(), invalidatePermissionCache: vi.fn(),
    });
    _requireLocal.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
    _requireLocal.cache[AUDIT_PATH] = fakeMod(AUDIT_PATH, {
      writeWorkflowAuditLog: vi.fn(async (params) => { auditWrites.push(params); }),
      diffChangedFields: () => ({ name: { before: 'Old name', after: 'New name (via Crystal-hydrated draft)' } }),
    });
    delete _requireLocal.cache[PLANGATE_PATH];
    delete _requireLocal.cache[ROUTER_PATH];
    const router = _requireLocal(ROUTER_PATH);
    const app = express(); app.use(express.json()); app.use('/api/workflows', router.default || router);

    const res = await inject(app, {
      method: 'PUT',
      url: '/api/workflows/w1',
      payload: JSON.stringify({ name: 'New name (via Crystal-hydrated draft)' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(200);
    expect(auditWrites).toHaveLength(1);
    // The critical assertion: attribution is the real clicking human, never
    // a synthetic "crystal" actor — identical to any other manual save.
    expect(auditWrites[0].actorUserId).toBe('human-user-42');
    expect(auditWrites[0].actorUserId).not.toBe('crystal');
  });
});
