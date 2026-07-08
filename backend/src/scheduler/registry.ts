/**
 * Declarative job registry — the single in-code source of truth for the scheduler service.
 * Every periodic job the scheduler owns is listed here; cadence and enablement are env-overridable.
 * Keep `docs/infrastructure/scheduled-jobs.md` in sync when adding a job.
 */
import { expireStaleBroadcasts } from './jobs/expireStaleBroadcasts';
import { reconciliation } from './jobs/reconciliation';
import { costDownDividend } from './jobs/costDownDividend';
import { creditLedgerMaintenance } from './jobs/creditLedgerMaintenance';
import { credentialHealth } from './jobs/credentialHealth';
import { reNotifyStaleApprovals } from './jobs/reNotifyStaleApprovals';
import { resumeDelayedExecutions } from './jobs/resumeDelayedExecutions';

export interface JobResult { affected?: number; note?: string }

export interface Job {
  name: string;
  description: string;
  intervalSec: number;
  enabled: boolean;
  handler: () => Promise<JobResult | void>;
}

const flag = (k: string, d: boolean): boolean => (process.env[k] != null ? process.env[k] === 'true' : d);
const intSec = (k: string, d: number): number => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : d;
};

export const JOBS: Job[] = [
  {
    name: 'expire-stale-broadcasts',
    description: 'Flip pending_approval broadcasts past their 72h expiry to expired.',
    intervalSec: intSec('JOB_EXPIRE_BROADCASTS_SEC', 300), // 5 min
    enabled: flag('JOB_EXPIRE_BROADCASTS', true),
    handler: expireStaleBroadcasts,
  },
  {
    name: 'credit-reconciliation',
    description: 'Ledger integrity invariants (read-only); emits credit_invariant_violations.',
    intervalSec: intSec('JOB_RECONCILIATION_SEC', 3_600), // hourly
    enabled: flag('JOB_RECONCILIATION', true),            // safe (read-only)
    handler: reconciliation,
  },
  {
    name: 'cost-down-dividend',
    description: 'Compute trailing COGS/credit (emits metric); allowance apply is dry-run by default.',
    intervalSec: intSec('JOB_COST_DOWN_DIVIDEND_SEC', 86_400), // daily measure
    enabled: flag('JOB_COST_DOWN_DIVIDEND', true),             // safe (measure-only unless COST_DOWN_DRY_RUN=false)
    handler: costDownDividend,
  },
  {
    name: 'credit-ledger-maintenance',
    description: 'Provision credit_ledger partitions ahead + drop partitions past retention.',
    intervalSec: intSec('JOB_CREDIT_LEDGER_MAINTENANCE_SEC', 86_400), // daily
    enabled: flag('JOB_CREDIT_LEDGER_MAINTENANCE', true),
    handler: creditLedgerMaintenance,
  },
  {
    name: 'credential-health',
    description: 'Probe configured integration keys (Stripe/OpenRouter/Clerk) for validity/expiry; report invalid/expiring.',
    intervalSec: intSec('JOB_CREDENTIAL_HEALTH_SEC', 21_600), // every 6h
    enabled: flag('JOB_CREDENTIAL_HEALTH', true),
    handler: () => credentialHealth(),
  },
  {
    // Approval TTL — simple expiry + re-notify (never auto-reject; see
    // jobs/reNotifyStaleApprovals.ts's header for the full design rationale).
    // Mirrors expire-stale-broadcasts's shape exactly; runs hourly (much shorter
    // than the 72h re-notify cadence itself — the SQL predicate inside the job,
    // not this interval, is what prevents re-spamming an approver).
    name: 'renotify-stale-approvals',
    description: 'Re-notify the owner of workflow_approvals stuck pending past WORKFLOW_APPROVAL_RENOTIFY_HOURS (default 72h). Never auto-rejects.',
    intervalSec: intSec('JOB_RENOTIFY_STALE_APPROVALS_SEC', 3_600), // hourly
    enabled: flag('JOB_RENOTIFY_STALE_APPROVALS', true),
    handler: reNotifyStaleApprovals,
  },
  {
    // flow.delay auto-resume (Priya, Wave 11, DEEP_AUDIT_UX_FINDINGS.md W-1).
    // Unlike renotify-stale-approvals (a human nudge), this job actively
    // continues execution once a delay's resume_at has passed — a delay has no
    // human in the loop at all. Ticks much tighter than the approval nudge
    // (default 60s, not hourly) since a delay is a promise to resume near-
    // exactly on time, not "eventually within a day"; the per-row idempotent
    // claim in workflowEngine.ts::resumeDelayedExecution (not this interval)
    // is what makes closely-spaced ticks safe under overlap.
    name: 'resume-delayed-executions',
    description: 'Auto-resume workflow_executions waiting on a flow.delay pause whose resume_at has passed. Never touches flow.approval waits.',
    intervalSec: intSec('JOB_RESUME_DELAYED_EXECUTIONS_SEC', 60), // every minute
    enabled: flag('JOB_RESUME_DELAYED_EXECUTIONS', true),
    handler: resumeDelayedExecutions,
  },
];
