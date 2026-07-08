// Human-readable error mapping layer for workflow run history (Nina, 2026-07-01,
// DEEP_AUDIT_PM_FINDINGS.md §4 / DEEP_AUDIT_UX_FINDINGS.md §3.5 finding R-1).
//
// `workflow_executions.error_message` and `workflow_step_executions.error_message`
// store the RAW `err.message` from whatever threw (an Axios error, a connector
// library exception, a DNS failure, ...) — see workflowEngine.ts's `catch (err)`
// sites. That raw string is genuinely useful for engineering debugging, so it is
// never mutated in the database. This module only transforms the value at the API
// response boundary (routes/workflows.ts), for display purposes — the DB always
// keeps the original.
//
// Deliberately a plain pattern-match, not an LLM call or i18n key lookup: these
// are infra-level failure signatures (timeouts, auth, DNS) that are the same
// words regardless of which action type threw them, and a raw-message fallback
// means a novel/unrecognized error is never hidden — only improved when we can.
export interface HumanizedError {
  /** Original, unmodified message — always present, always safe to log/debug with. */
  raw: string;
  /** Plain-language equivalent when a known pattern matched; otherwise equals `raw`. */
  message: string;
  /** Whether a known pattern matched (lets the frontend show raw+humanized, or just raw). */
  matched: boolean;
}

interface Pattern {
  test: RegExp;
  humanize: (raw: string, actionType?: string) => string;
}

const PATTERNS: Pattern[] = [
  {
    // AbortSignal.timeout() / axios timeout / generic timeout language.
    test: /\b(timed?\s?out|ETIMEDOUT|ESOCKETTIMEDOUT|The operation was aborted)\b/i,
    humanize: (_raw, actionType) =>
      `The ${actionType ? describeAction(actionType) : 'request'} took too long to respond and timed out. The service may be slow or unreachable — try again, or check its status page.`,
  },
  {
    // HTTP 401/403 embedded in an Axios-style message ("Request failed with status code 401") or a bare "401"/"Unauthorized".
    test: /\b(401|Unauthorized)\b/i,
    humanize: (_raw, actionType) =>
      `${actionType ? describeAction(actionType) : 'The request'} was rejected because the credentials are missing or invalid. Reconnect this integration in Settings.`,
  },
  {
    test: /\b(403|Forbidden)\b/i,
    humanize: (_raw, actionType) =>
      `${actionType ? describeAction(actionType) : 'The request'} was rejected — the connected account doesn't have permission to do this. Check the integration's access scope.`,
  },
  {
    // DNS / connection-refused failures (ENOTFOUND, EAI_AGAIN, ECONNREFUSED, ECONNRESET).
    test: /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET)\b/,
    humanize: (_raw, actionType) =>
      `Couldn't reach the ${actionType ? describeAction(actionType) : 'external'} service — the address may be wrong, or the service may be down.`,
  },
  {
    // Rate limiting (HTTP 429 or explicit "rate limit" language).
    test: /\b(429|rate.?limit(ed)?|Too Many Requests)\b/i,
    humanize: (_raw, actionType) =>
      `${actionType ? describeAction(actionType) : 'The request'} was rate-limited by the receiving service. It will be retried automatically; no action needed unless this keeps happening.`,
  },
  {
    // Generic 5xx from a downstream integration.
    test: /\b(50[0-4])\b.*status|status.*\b(50[0-4])\b/i,
    humanize: (_raw, actionType) =>
      `${actionType ? describeAction(actionType) : 'The'} service returned a server error. This is usually on their end — try again shortly.`,
  },
];

function describeAction(actionType: string): string {
  // 'notify.slack' -> 'Slack', 'jira.create_issue' -> 'Jira', etc. Falls back to
  // the raw action type string for anything not in this small display map.
  const [integration] = actionType.split('.');
  const DISPLAY: Record<string, string> = {
    notify: 'notification',
    jira: 'Jira',
    salesforce: 'Salesforce',
    servicenow: 'ServiceNow',
    zendesk: 'Zendesk',
    crystal: 'Crystal',
    data: 'data',
    flow: 'workflow',
  };
  return DISPLAY[integration] || integration;
}

/**
 * Map a raw exception message to a plain-language equivalent when a known
 * failure pattern matches; otherwise returns the raw message unchanged (never
 * hides information — improves it only when a confident pattern is found).
 */
export function humanizeExecutionError(rawMessage: string | null | undefined, actionType?: string): HumanizedError | null {
  if (!rawMessage) return null;
  for (const pattern of PATTERNS) {
    if (pattern.test.test(rawMessage)) {
      return { raw: rawMessage, message: pattern.humanize(rawMessage, actionType), matched: true };
    }
  }
  return { raw: rawMessage, message: rawMessage, matched: false };
}
