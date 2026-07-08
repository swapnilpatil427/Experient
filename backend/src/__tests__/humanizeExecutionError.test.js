// Unit coverage for lib/humanizeExecutionError.ts (Nina, 2026-07-01,
// DEEP_AUDIT_UX_FINDINGS.md finding R-1 — `error_message` was a raw, untranslated
// exception string in run history). Pure function, no mocking needed.
import { describe, it, expect } from 'vitest';
import { humanizeExecutionError } from '../lib/humanizeExecutionError';

describe('humanizeExecutionError', () => {
  it('returns null for a null/undefined/empty raw message', () => {
    expect(humanizeExecutionError(null)).toBeNull();
    expect(humanizeExecutionError(undefined)).toBeNull();
    expect(humanizeExecutionError('')).toBeNull();
  });

  it('never mutates or drops the raw message — always present verbatim', () => {
    const raw = 'Request failed with status code 401';
    const result = humanizeExecutionError(raw, 'jira.create_issue');
    expect(result.raw).toBe(raw);
  });

  it('maps a timeout error to plain language', () => {
    const result = humanizeExecutionError('The operation was aborted due to timeout', 'jira.create_issue');
    expect(result.matched).toBe(true);
    expect(result.message).toMatch(/took too long|timed out/i);
    expect(result.message).toMatch(/Jira/);
  });

  it('maps ETIMEDOUT to plain language', () => {
    const result = humanizeExecutionError('connect ETIMEDOUT 10.0.0.1:443', 'notify.webhook');
    expect(result.matched).toBe(true);
    expect(result.message).toMatch(/timed out/i);
  });

  it('maps a 401 to a credentials message', () => {
    const result = humanizeExecutionError('Request failed with status code 401', 'salesforce.update_contact');
    expect(result.matched).toBe(true);
    expect(result.message).toMatch(/credentials/i);
    expect(result.message).toMatch(/Salesforce/);
    expect(result.message).toMatch(/reconnect/i);
  });

  it('maps a 403 to a permissions message', () => {
    const result = humanizeExecutionError('Request failed with status code 403', 'zendesk.create_ticket');
    expect(result.matched).toBe(true);
    expect(result.message).toMatch(/permission/i);
  });

  it('maps DNS/connection-refused failures', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET']) {
      const result = humanizeExecutionError(`${code} api.example.com`, 'notify.webhook');
      expect(result.matched).toBe(true);
      expect(result.message).toMatch(/couldn't reach|down/i);
    }
  });

  it('maps rate-limit (429) errors', () => {
    const result = humanizeExecutionError('Request failed with status code 429', 'notify.slack');
    expect(result.matched).toBe(true);
    expect(result.message).toMatch(/rate-limited/i);
    expect(result.message).toMatch(/retried automatically/i);
  });

  it('maps a generic 5xx from a downstream integration', () => {
    const result = humanizeExecutionError('Request failed with status code 503', 'servicenow.create_incident');
    expect(result.matched).toBe(true);
    expect(result.message).toMatch(/server error/i);
  });

  it('falls back to the raw message, unmodified, for an unrecognized pattern — never hides information', () => {
    const raw = 'Some completely novel failure mode xyz123';
    const result = humanizeExecutionError(raw, 'jira.create_issue');
    expect(result.matched).toBe(false);
    expect(result.message).toBe(raw);
    expect(result.raw).toBe(raw);
  });

  it('works without an actionType (falls back to generic phrasing)', () => {
    const result = humanizeExecutionError('Request failed with status code 401');
    expect(result.matched).toBe(true);
    expect(result.message).toMatch(/credentials/i);
  });
});
