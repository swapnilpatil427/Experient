import { describe, it, expect } from 'vitest';
import {
  extractNotifyTarget, flattenNotifyTarget,
} from '../../../../components/workflow-builder/sentence/contentSections';

// Wave 9 — the seam between the frontend's nested `target: NotifyTarget`
// convenience field and Nina's backend contract, which persists targeting as
// FLAT fields directly on the action config (`{ targetType, userIds, ... }`),
// backward-compatible with pre-targeting configs that only ever had
// `userId`/`userIds` and no `targetType` at all. See
// docs/automation-hub/TEMPLATE_FLOW_AND_RECIPIENT_TARGETING_SPEC.md §Issue 2.
describe('flattenNotifyTarget', () => {
  it('flattens a users target into targetType + userIds', () => {
    expect(flattenNotifyTarget({ targetType: 'users', userIds: ['u1', 'u2'] }))
      .toEqual({ targetType: 'users', userIds: ['u1', 'u2'] });
  });

  it('flattens a role target into targetType + roleId', () => {
    expect(flattenNotifyTarget({ targetType: 'role', roleId: 'role-1' }))
      .toEqual({ targetType: 'role', roleId: 'role-1' });
  });

  it('flattens a department target into targetType + departmentId', () => {
    expect(flattenNotifyTarget({ targetType: 'department', departmentId: 'dept-1' }))
      .toEqual({ targetType: 'department', departmentId: 'dept-1' });
  });

  it('flattens a group target into targetType + groupId', () => {
    expect(flattenNotifyTarget({ targetType: 'group', groupId: 'group-1' }))
      .toEqual({ targetType: 'group', groupId: 'group-1' });
  });

  it('returns an empty object for undefined (no target picked yet)', () => {
    expect(flattenNotifyTarget(undefined)).toEqual({});
  });
});

describe('extractNotifyTarget — modern (flat, targetType-tagged) configs', () => {
  it('reads a users config', () => {
    expect(extractNotifyTarget({ targetType: 'users', userIds: ['u1'], subject: 'Hi' }))
      .toEqual({ targetType: 'users', userIds: ['u1'] });
  });

  it('reads a role config, ignoring unrelated fields alongside it', () => {
    expect(extractNotifyTarget({ targetType: 'role', roleId: 'role-1', channel: '#x' }))
      .toEqual({ targetType: 'role', roleId: 'role-1' });
  });

  it('reads a department config', () => {
    expect(extractNotifyTarget({ targetType: 'department', departmentId: 'dept-1' }))
      .toEqual({ targetType: 'department', departmentId: 'dept-1' });
  });

  it('reads a group config', () => {
    expect(extractNotifyTarget({ targetType: 'group', groupId: 'group-1' }))
      .toEqual({ targetType: 'group', groupId: 'group-1' });
  });
});

describe('extractNotifyTarget — legacy backward-compat (no targetType)', () => {
  it('a legacy notify.email config with only config.userId (singular) becomes a single-user "users" target', () => {
    expect(extractNotifyTarget({ userId: 'legacy-user-1' }))
      .toEqual({ targetType: 'users', userIds: ['legacy-user-1'] });
  });

  it('a legacy notify.in_app config with only config.userIds (plural) becomes a "users" target', () => {
    expect(extractNotifyTarget({ userIds: ['legacy-1', 'legacy-2'] }))
      .toEqual({ targetType: 'users', userIds: ['legacy-1', 'legacy-2'] });
  });

  it('an empty legacy userIds array resolves to undefined, not an empty users target', () => {
    expect(extractNotifyTarget({ userIds: [] })).toBeUndefined();
  });

  it('a config with neither modern nor legacy fields resolves to undefined', () => {
    expect(extractNotifyTarget({ subject: 'Hi' })).toBeUndefined();
    expect(extractNotifyTarget({})).toBeUndefined();
    expect(extractNotifyTarget(undefined)).toBeUndefined();
  });
});
