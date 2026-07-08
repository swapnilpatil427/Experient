// Shared recipient-resolution helper for anything that needs to turn a
// targeting spec (explicit user list, role, department, or group) into a flat
// list of user ids — currently: workflowEngine.ts's notify.email/notify.in_app
// actions. Extracted here (rather than left inline in routes/roles.ts,
// routes/departments.ts, routes/groups.ts) so the HTTP routes' member-count/
// member-list queries and this workflow-engine consumer share ONE
// implementation that can't drift apart.
//
// Queries below are copy-mirrors of the existing, already-shipped queries in:
//   - routes/roles.ts        (the `assigned_count` LEFT JOIN's WHERE shape)
//   - routes/departments.ts  (dept_user_counts CTE's WHERE shape)
//   - routes/groups.ts       (`GET /:id/members`)
// Reuse the exact same table/column names and filters (org scoping,
// is_active/deprovisioned_at where applicable) so results here are always
// consistent with what an admin sees in the Roles/Departments/Groups UI.
import { query } from './db';

export type RecipientTargetType = 'users' | 'role' | 'department' | 'group';

export interface RecipientTarget {
  targetType?: RecipientTargetType;
  userIds?: string[];
  roleId?: string;
  departmentId?: string;
  groupId?: string;
}

/**
 * Resolve a role to its currently-assigned users.
 * Mirrors routes/roles.ts's `assigned_count` join: `user_profiles up ... WHERE
 * up.role_id = $1 AND up.org_id = $2`. No is_active filter there today, so we
 * don't add one here either — behavior must match what the Roles page counts.
 */
export async function resolveRoleMembers(orgId: string, roleId: string): Promise<string[]> {
  const { rows } = await query(
    `SELECT user_id FROM user_profiles WHERE role_id = $1 AND org_id = $2`,
    [roleId, orgId]
  );
  return (rows as Array<{ user_id: string }>).map((r) => r.user_id);
}

/**
 * Resolve a department to its currently-assigned users.
 *
 * DIRECT MEMBERS ONLY — does NOT walk sub-departments. This intentionally
 * matches routes/departments.ts's `dept_user_counts` CTE (the exact query
 * GET /api/departments uses for its `directMemberCount` field), not the same
 * route's `totalMemberCount` tree rollup (which sums a department's own count
 * plus every descendant's, for tree-display purposes only). Picking "Support"
 * with two sub-departments will notify only people with
 * `department_id = Support`'s own id — NOT people in "Support > Tier 2" etc.
 *
 * Frontend implication (recipient-count preview): build the "will notify N
 * people" preview off `directMemberCount` from GET /api/departments, NOT
 * `totalMemberCount` — the two will diverge for any department with
 * sub-departments, and `totalMemberCount` would overstate what this resolver
 * actually delivers to.
 *
 * If subtree-inclusive targeting is ever wanted, it needs to be a distinct,
 * explicitly-labeled option (e.g. "Support + all sub-departments") — silently
 * changing this function's semantics would be a breaking, hard-to-notice
 * change for any workflow already relying on direct-only delivery.
 *
 * Same active-user filter as that CTE: `is_active = TRUE AND deprovisioned_at IS NULL`.
 */
export async function resolveDepartmentMembers(orgId: string, departmentId: string): Promise<string[]> {
  const { rows } = await query(
    `SELECT user_id FROM user_profiles
      WHERE department_id = $1 AND org_id = $2 AND is_active = TRUE AND deprovisioned_at IS NULL`,
    [departmentId, orgId]
  );
  return (rows as Array<{ user_id: string }>).map((r) => r.user_id);
}

/**
 * Resolve a group to its member user ids. Mirrors routes/groups.ts's
 * `GET /:id/members` query against `user_group_members` — this table already
 * holds materialized membership for BOTH static and dynamic groups (dynamic
 * groups are re-materialized into it by lib/dynamicGroups.ts on rule change),
 * so one query covers both group types with no branching needed here.
 */
export async function resolveGroupMembers(orgId: string, groupId: string): Promise<string[]> {
  const { rows } = await query(
    `SELECT user_id FROM user_group_members WHERE group_id = $1 AND org_id = $2`,
    [groupId, orgId]
  );
  return (rows as Array<{ user_id: string }>).map((r) => r.user_id);
}

export interface ResolvedRecipients {
  userIds: string[];
  // Set when targetType resolved to a role/department/group with zero current
  // members, so the caller can log/skip with a specific, diagnosable reason
  // instead of a bare empty array indistinguishable from "no target configured
  // at all". Undefined when resolution is otherwise normal (including the
  // legacy explicit-userIds path, which has no "empty group" concept).
  emptyReason?: 'role_has_no_members' | 'department_has_no_members' | 'group_has_no_members';
}

/**
 * Resolve any of the 4 targeting modes to a flat, deduplicated user id list.
 *
 * Precedence when multiple fields are present on `target` (documented, not
 * guessed): explicit `targetType` wins outright — only the field(s) matching
 * that type are consulted. `targetType` absent falls back to legacy detection
 * for backward compatibility: `userIds` (or singular `userId`, via the
 * caller-normalized `userIds` array) if present, else roleId, else
 * departmentId, else groupId. This keeps every already-saved workflow
 * (which has none of these fields set except a bare userId/userIds) resolving
 * exactly as before.
 */
export async function resolveRecipients(orgId: string, target: RecipientTarget): Promise<ResolvedRecipients> {
  const targetType = target.targetType
    || (target.userIds?.length ? 'users'
      : target.roleId ? 'role'
      : target.departmentId ? 'department'
      : target.groupId ? 'group'
      : undefined);

  switch (targetType) {
    case 'users':
      return { userIds: Array.from(new Set(target.userIds || [])) };
    case 'role': {
      if (!target.roleId) return { userIds: [] };
      const userIds = await resolveRoleMembers(orgId, target.roleId);
      return userIds.length ? { userIds: Array.from(new Set(userIds)) } : { userIds: [], emptyReason: 'role_has_no_members' };
    }
    case 'department': {
      if (!target.departmentId) return { userIds: [] };
      const userIds = await resolveDepartmentMembers(orgId, target.departmentId);
      return userIds.length ? { userIds: Array.from(new Set(userIds)) } : { userIds: [], emptyReason: 'department_has_no_members' };
    }
    case 'group': {
      if (!target.groupId) return { userIds: [] };
      const userIds = await resolveGroupMembers(orgId, target.groupId);
      return userIds.length ? { userIds: Array.from(new Set(userIds)) } : { userIds: [], emptyReason: 'group_has_no_members' };
    }
    default:
      return { userIds: [] };
  }
}
