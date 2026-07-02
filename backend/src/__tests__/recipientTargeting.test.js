// Role/department/group notification targeting (Nina, 2026-07-01).
//
// Covers:
//   1. lib/recipientResolver.ts in isolation — the 4 targeting modes, dedup,
//      and the zero-members-resolves-to-a-clear-reason behavior.
//   2. workflowEngine.ts's notify.email/notify.in_app consuming the resolver —
//      looping over N resolved recipients, precedence (targetType wins over
//      legacy userId/userIds when both are present), and backward compat for
//      workflows saved before this change (bare config.userId / config.userIds,
//      or no targeting at all).
//
// Mock pattern mirrors the existing require.cache injection convention used by
// workflowEngine.test.js / xmScenarioVerification.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inject from 'light-my-request';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const DB_PATH        = _require.resolve(resolve(__dirname, '../lib/db'));
const NOTIF_PATH     = _require.resolve(resolve(__dirname, '../lib/notifications'));
const CH_PATH        = _require.resolve(resolve(__dirname, '../lib/channels'));
const ENGINE_PATH    = _require.resolve(resolve(__dirname, '../lib/workflowEngine'));
const CREDS_PATH     = _require.resolve(resolve(__dirname, '../lib/workflowCredentials'));
const CONN_PATH      = _require.resolve(resolve(__dirname, '../lib/connectors'));
const RESOLVER_PATH  = _require.resolve(resolve(__dirname, '../lib/recipientResolver'));

function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }

let dbQuery, createNotificationMock, sendSlackMock, sendEmailMock;

function loadResolver() {
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  delete _require.cache[RESOLVER_PATH];
  return _require(RESOLVER_PATH);
}

function loadEngine() {
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[NOTIF_PATH] = fakeMod(NOTIF_PATH, { createNotification: createNotificationMock, serialize: (r) => r });
  _require.cache[CH_PATH] = fakeMod(CH_PATH, { sendSlack: sendSlackMock, sendEmail: sendEmailMock });
  delete _require.cache[CONN_PATH];
  delete _require.cache[CREDS_PATH];
  delete _require.cache[RESOLVER_PATH];
  delete _require.cache[ENGINE_PATH];
  return _require(ENGINE_PATH);
}

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [] }));
  createNotificationMock = vi.fn(async () => ({ id: 'n1' }));
  sendSlackMock = vi.fn(async () => ({ channel: 'slack', delivered: true }));
  sendEmailMock = vi.fn(async () => ({ channel: 'email', delivered: true }));
});

// ── recipientResolver.ts — unit tests ────────────────────────────────────────

describe('resolveRecipients', () => {
  it('targetType "users" returns the explicit userIds, deduplicated', async () => {
    const { resolveRecipients } = loadResolver();
    const result = await resolveRecipients('o1', { targetType: 'users', userIds: ['u1', 'u2', 'u1'] });
    expect(result).toEqual({ userIds: ['u1', 'u2'] });
    expect(dbQuery).not.toHaveBeenCalled(); // no DB round trip needed for explicit users
  });

  it('targetType "role" resolves via user_profiles.role_id (mirrors roles.ts assigned_count join)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('role_id = $1')) return { rows: [{ user_id: 'u1' }, { user_id: 'u2' }] };
      return { rows: [] };
    });
    const { resolveRecipients } = loadResolver();
    const result = await resolveRecipients('o1', { targetType: 'role', roleId: 'role-hrbp' });
    expect(result.userIds.sort()).toEqual(['u1', 'u2']);
    expect(result.emptyReason).toBeUndefined();
    const call = dbQuery.mock.calls.find(([text]) => text.includes('role_id'));
    expect(call[1]).toEqual(['role-hrbp', 'o1']);
  });

  it('targetType "role" with zero assigned users returns a clear emptyReason, not a silent empty array', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { resolveRecipients } = loadResolver();
    const result = await resolveRecipients('o1', { targetType: 'role', roleId: 'role-empty' });
    expect(result.userIds).toEqual([]);
    expect(result.emptyReason).toBe('role_has_no_members');
  });

  it('targetType "department" resolves via user_profiles.department_id, active users only', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('department_id = $1')) {
        expect(text).toContain('is_active = TRUE');
        expect(text).toContain('deprovisioned_at IS NULL');
        return { rows: [{ user_id: 'u3' }] };
      }
      return { rows: [] };
    });
    const { resolveRecipients } = loadResolver();
    const result = await resolveRecipients('o1', { targetType: 'department', departmentId: 'dept-hr' });
    expect(result.userIds).toEqual(['u3']);
  });

  it('targetType "department" with zero members returns department_has_no_members', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { resolveRecipients } = loadResolver();
    const result = await resolveRecipients('o1', { targetType: 'department', departmentId: 'dept-empty' });
    expect(result).toEqual({ userIds: [], emptyReason: 'department_has_no_members' });
  });

  it('targetType "department" is DIRECT MEMBERS ONLY — a sub-department\'s member must NOT be included (mirrors GET /api/departments\' directMemberCount, not the tree\'s totalMemberCount rollup)', async () => {
    // Simulate: "Support" (parent) has zero direct members; "Support > Tier 2"
    // (child) has one member. Targeting "Support" by id must query strictly by
    // that department_id and resolve to zero people — the query must never
    // walk `path`/descendant department ids to pull in the child's member.
    dbQuery = vi.fn(async (text, params) => {
      expect(text).not.toMatch(/path|descendant|recursive/i);
      if (text.includes('department_id = $1') && params[0] === 'dept-support') return { rows: [] };
      if (text.includes('department_id = $1') && params[0] === 'dept-support-tier2') return { rows: [{ user_id: 'tier2-user' }] };
      return { rows: [] };
    });
    const { resolveRecipients } = loadResolver();
    const result = await resolveRecipients('o1', { targetType: 'department', departmentId: 'dept-support' });
    expect(result).toEqual({ userIds: [], emptyReason: 'department_has_no_members' });
  });

  it('targetType "group" resolves via user_group_members (mirrors groups.ts GET /:id/members)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('user_group_members')) return { rows: [{ user_id: 'u4' }, { user_id: 'u5' }] };
      return { rows: [] };
    });
    const { resolveRecipients } = loadResolver();
    const result = await resolveRecipients('o1', { targetType: 'group', groupId: 'grp-cs' });
    expect(result.userIds.sort()).toEqual(['u4', 'u5']);
  });

  it('targetType "group" with zero members returns group_has_no_members', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { resolveRecipients } = loadResolver();
    const result = await resolveRecipients('o1', { targetType: 'group', groupId: 'grp-empty' });
    expect(result).toEqual({ userIds: [], emptyReason: 'group_has_no_members' });
  });

  it('legacy detection (no targetType): falls back to userIds, then roleId, then departmentId, then groupId', async () => {
    const { resolveRecipients } = loadResolver();
    // userIds present, roleId also present — legacy detection picks userIds first.
    const r1 = await resolveRecipients('o1', { userIds: ['u1'], roleId: 'role-x' });
    expect(r1.userIds).toEqual(['u1']);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('no targeting fields at all resolves to an empty list with no emptyReason (caller distinguishes "not configured")', async () => {
    const { resolveRecipients } = loadResolver();
    const result = await resolveRecipients('o1', {});
    expect(result).toEqual({ userIds: [] });
  });

  it('explicit targetType wins even if legacy userId-shaped fields are also present', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('role_id = $1')) return { rows: [{ user_id: 'role-member' }] };
      return { rows: [] };
    });
    const { resolveRecipients } = loadResolver();
    const result = await resolveRecipients('o1', { targetType: 'role', roleId: 'role-x', userIds: ['legacy-user'] });
    expect(result.userIds).toEqual(['role-member']);
  });
});

// ── workflowEngine.ts — notify.email extended targeting ──────────────────────

describe('notify.email — role/department/group targeting', () => {
  it('loops sendEmail once per resolved recipient when targetType=role resolves to multiple users', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('role_id = $1')) return { rows: [{ user_id: 'hrbp-1' }, { user_id: 'hrbp-2' }, { user_id: 'hrbp-3' }] };
      return { rows: [] };
    });
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.email', config: { targetType: 'role', roleId: 'role-hrbp', subject: 'Escalation' } },
      { orgId: 'o1', workflowId: 'w1', event: { type: 'alert.fired' }, vars: {} }
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(3);
    expect(sendEmailMock).toHaveBeenNthCalledWith(1, 'o1', 'hrbp-1', expect.any(Object));
    expect(sendEmailMock).toHaveBeenNthCalledWith(2, 'o1', 'hrbp-2', expect.any(Object));
    expect(sendEmailMock).toHaveBeenNthCalledWith(3, 'o1', 'hrbp-3', expect.any(Object));
    expect(result.status).toBe('completed');
    expect(result.output.recipients).toBe(3);
    expect(result.output.delivered).toBe(3);
  });

  it('targetType=department resolves and delivers to each department member', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('department_id = $1')) return { rows: [{ user_id: 'd1' }, { user_id: 'd2' }] };
      return { rows: [] };
    });
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.email', config: { targetType: 'department', departmentId: 'dept-cs', subject: 'X' } },
      { orgId: 'o1', workflowId: 'w1', event: {}, vars: {} }
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('completed');
  });

  it('targetType=group resolves and delivers to each group member', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('user_group_members')) return { rows: [{ user_id: 'g1' }] };
      return { rows: [] };
    });
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.email', config: { targetType: 'group', groupId: 'grp-cs', subject: 'X' } },
      { orgId: 'o1', workflowId: 'w1', event: {}, vars: {} }
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith('o1', 'g1', expect.any(Object));
    expect(result.status).toBe('completed');
  });

  it('targetType=role resolving to zero members skips cleanly with role_has_no_members (not indistinguishable from a successful send)', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.email', config: { targetType: 'role', roleId: 'role-empty', subject: 'X' } },
      { orgId: 'o1', workflowId: 'w1', event: {}, vars: {} }
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(result.status).toBe('skipped');
    expect(result.output).toEqual({ reason: 'role_has_no_members' });
  });

  it('targetType=department resolving to zero members skips with department_has_no_members', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.email', config: { targetType: 'department', departmentId: 'dept-empty', subject: 'X' } },
      { orgId: 'o1', workflowId: 'w1', event: {}, vars: {} }
    );
    expect(result.status).toBe('skipped');
    expect(result.output).toEqual({ reason: 'department_has_no_members' });
  });

  it('targetType=group resolving to zero members skips with group_has_no_members', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.email', config: { targetType: 'group', groupId: 'grp-empty', subject: 'X' } },
      { orgId: 'o1', workflowId: 'w1', event: {}, vars: {} }
    );
    expect(result.status).toBe('skipped');
    expect(result.output).toEqual({ reason: 'group_has_no_members' });
  });

  it('backward compat: an old workflow with only config.userId (singular) still works unchanged', async () => {
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.email', config: { userId: 'legacy-user-1', subject: 'X' } },
      { orgId: 'o1', workflowId: 'w1', event: { userId: 'someone-else' }, vars: {} }
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith('o1', 'legacy-user-1', expect.any(Object));
    expect(result.status).toBe('completed');
  });

  it('SECURITY regression guard: no targeting configured at all still skips cleanly, never falls back to ctx.event.userId', async () => {
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.email', config: { subject: 'Manager effectiveness alert' } },
      { orgId: 'o1', workflowId: 'w1', event: { userId: 'scored-manager-999' }, vars: {} }
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(result.status).toBe('skipped');
    expect(result.output).toEqual({ reason: 'no_recipient_configured' });
  });

  it('a partial-delivery outcome (some sendEmail calls fail) still reports completed with an accurate delivered count', async () => {
    let call = 0;
    sendEmailMock = vi.fn(async () => {
      call++;
      return { channel: 'email', delivered: call !== 2 }; // 2nd recipient fails
    });
    dbQuery = vi.fn(async (text) => {
      if (text.includes('role_id = $1')) return { rows: [{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'c' }] };
      return { rows: [] };
    });
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.email', config: { targetType: 'role', roleId: 'role-x', subject: 'X' } },
      { orgId: 'o1', workflowId: 'w1', event: {}, vars: {} }
    );
    expect(result.status).toBe('completed');
    expect(result.output.recipients).toBe(3);
    expect(result.output.delivered).toBe(2);
  });
});

// ── workflowEngine.ts — notify.in_app extended targeting ─────────────────────

describe('notify.in_app — extended role/department/group targeting', () => {
  it('targetType=role creates one notification per resolved user', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('role_id = $1')) return { rows: [{ user_id: 'r1' }, { user_id: 'r2' }] };
      return { rows: [] };
    });
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.in_app', config: { targetType: 'role', roleId: 'role-x', title: 'Hi' } },
      { orgId: 'o1', workflowId: 'w1', event: {}, vars: {} }
    );
    expect(createNotificationMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('completed');
    expect(result.output.notifications).toBe(2);
  });

  it('targetType=department creates one notification per resolved user', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('department_id = $1')) return { rows: [{ user_id: 'd1' }] };
      return { rows: [] };
    });
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.in_app', config: { targetType: 'department', departmentId: 'dept-x', title: 'Hi' } },
      { orgId: 'o1', workflowId: 'w1', event: {}, vars: {} }
    );
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
  });

  it('targetType=group creates one notification per resolved user', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('user_group_members')) return { rows: [{ user_id: 'g1' }, { user_id: 'g2' }] };
      return { rows: [] };
    });
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.in_app', config: { targetType: 'group', groupId: 'grp-x', title: 'Hi' } },
      { orgId: 'o1', workflowId: 'w1', event: {}, vars: {} }
    );
    expect(createNotificationMock).toHaveBeenCalledTimes(2);
  });

  it('targetType=role resolving to zero members skips with role_has_no_members (in_app now gets the same diagnosability as email)', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.in_app', config: { targetType: 'role', roleId: 'role-empty', title: 'Hi' } },
      { orgId: 'o1', workflowId: 'w1', event: {}, vars: {} }
    );
    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(result.status).toBe('skipped');
    expect(result.output).toEqual({ reason: 'role_has_no_members' });
  });

  it('backward compat: an old workflow with only config.userIds (plural array) still works unchanged', async () => {
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.in_app', config: { userIds: ['legacy-a', 'legacy-b'], title: 'Hi' } },
      { orgId: 'o1', workflowId: 'w1', event: {}, vars: {} }
    );
    expect(createNotificationMock).toHaveBeenCalledTimes(2);
    expect(createNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'legacy-a' }));
    expect(createNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'legacy-b' }));
    expect(result.status).toBe('completed');
    expect(dbQuery).not.toHaveBeenCalled(); // explicit userIds never needs a resolver DB round trip
  });

  it('regression guard: no targeting configured at all still falls back to ctx.event.userId (pre-existing notify.in_app behavior, unaffected by the Priority 1 email fix since in_app has no cross-user delivery risk)', async () => {
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.in_app', config: { title: 'Hi' } },
      { orgId: 'o1', workflowId: 'w1', event: { userId: 'u1' }, vars: {} }
    );
    expect(createNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }));
    expect(result.status).toBe('completed');
  });

  it('regression guard: ctx.recipientUserIds is still honored when config carries no targeting', async () => {
    const { executeAction } = loadEngine();
    const result = await executeAction(
      { type: 'action', action: 'notify.in_app', config: { title: 'Hi' } },
      { orgId: 'o1', workflowId: 'w1', event: {}, vars: {}, recipientUserIds: ['ctx-user-1', 'ctx-user-2'] }
    );
    expect(createNotificationMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('completed');
  });
});

// ── GET /api/workflows/notification-targets ──────────────────────────────────
//
// Rohan (UX, 2026-07-01) flagged that GET /api/roles, /api/departments,
// /api/groups all require `users:manage` — an admin-level permission a real
// built-in role (org:program_admin: workflows:manage=ALL, users:manage=NONE,
// see lib/rbac.ts) does not have, which would make the notify.email/in_app
// role/department/group picker unusable for that role. This endpoint is the
// fix: id+name+memberCount only, gated by `workflows:manage` (the permission
// this router already uniformly requires), no PII, no write access.
const AUTH_PATH  = _require.resolve(resolve(__dirname, '../middleware/auth'));
const PERM_PATH  = _require.resolve(resolve(__dirname, '../middleware/requirePermission'));
const ENGINE_PATH2 = _require.resolve(resolve(__dirname, '../lib/workflowEngine'));
const REG_PATH   = _require.resolve(resolve(__dirname, '../lib/workflowRegistry'));
const AGENTS_PATH = _require.resolve(resolve(__dirname, '../lib/agentsClient'));
const ROUTER_PATH = _require.resolve(resolve(__dirname, '../routes/workflows'));

function buildWorkflowsApp(routeDbQuery, permissionAction = 'workflows:manage') {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, res, next) => { req.orgId = 'o1'; req.userId = 'u1'; next(); },
  });
  _require.cache[PERM_PATH] = fakeMod(PERM_PATH, {
    requirePermission: (action) => (req, res, next) => {
      if (action !== permissionAction) { res.status(403).json({ error: `forbidden: ${action}` }); return; }
      next();
    },
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: routeDbQuery, default: { query: routeDbQuery } });
  _require.cache[ENGINE_PATH2] = fakeMod(ENGINE_PATH2, { runWorkflow: vi.fn(), resumeWorkflow: vi.fn(), computeCooldownStatus: () => null });
  _require.cache[REG_PATH] = fakeMod(REG_PATH, { registry: () => ({}) });
  _require.cache[AGENTS_PATH] = fakeMod(AGENTS_PATH, { parseWorkflowNL: vi.fn(), UnparseableWorkflowError: class extends Error {} });
  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express(); app.use(express.json()); app.use('/api/workflows', router.default || router);
  return app;
}

describe('GET /api/workflows/notification-targets', () => {
  it('is reachable with only workflows:manage (does NOT require users:manage)', async () => {
    const routeDbQuery = vi.fn(async (text) => {
      if (text.includes('FROM org_roles')) return { rows: [{ id: 'role-1', name: 'HRBP', member_count: 3 }] };
      if (text.includes('FROM departments')) return { rows: [{ id: 'dept-1', name: 'Support', member_count: 5 }] };
      if (text.includes('FROM user_groups')) return { rows: [{ id: 'grp-1', name: 'CS Team', member_count: 2 }] };
      return { rows: [] };
    });
    const app = buildWorkflowsApp(routeDbQuery, 'workflows:manage');
    const res = await inject(app, { method: 'GET', url: '/api/workflows/notification-targets' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.roles).toEqual([{ id: 'role-1', name: 'HRBP', memberCount: 3 }]);
    expect(body.departments).toEqual([{ id: 'dept-1', name: 'Support', memberCount: 5 }]);
    expect(body.groups).toEqual([{ id: 'grp-1', name: 'CS Team', memberCount: 2 }]);
    // No PII fields (email/avatar/displayName) leak through this endpoint.
    expect(JSON.stringify(body)).not.toMatch(/email|avatar|displayName/i);
  });

  it('403s when the caller lacks even workflows:manage (still gated, not a public/unauthenticated hole)', async () => {
    const app = buildWorkflowsApp(vi.fn(async () => ({ rows: [] })), 'some:other:permission');
    const res = await inject(app, { method: 'GET', url: '/api/workflows/notification-targets' });
    expect(res.statusCode).toBe(403);
  });

  it('department member_count query mirrors direct-only semantics (is_active/deprovisioned_at filter, no path/subtree walk)', async () => {
    const routeDbQuery = vi.fn(async (text) => {
      if (text.includes('FROM departments')) {
        expect(text).toContain('is_active = TRUE AND up.deprovisioned_at IS NULL');
        expect(text).not.toMatch(/path|descendant|recursive/i);
        return { rows: [{ id: 'dept-1', name: 'Support', member_count: 0 }] };
      }
      return { rows: [] };
    });
    const app = buildWorkflowsApp(routeDbQuery, 'workflows:manage');
    const res = await inject(app, { method: 'GET', url: '/api/workflows/notification-targets' });
    expect(res.statusCode).toBe(200);
    expect(res.json().departments[0].memberCount).toBe(0);
  });
});
