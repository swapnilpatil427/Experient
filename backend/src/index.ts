// Side-effect bootstrap — order matters:
import './polyfill-fetch'; // global fetch polyfill for Node < 18 (before Clerk)
import './instrument';     // Sentry tracing — must be second (before app code)
import './env';            // dotenv — must run before any module reads process.env

// ── All static imports below — env vars are now loaded ───────────────────────
import * as Sentry from '@sentry/node';
import express from 'express';
import cors from 'cors';
import logger from './lib/logger';
import { resolveClerkSecretKey } from './lib/clerkKeys';
import { register } from './lib/metrics';
import { query as dbQuery, waitForDb } from './lib/db';
import { getRedisClient } from './lib/redis';
import requestId from './middleware/requestId';
import httpLogger from './middleware/httpLogger';
import { apiLimiter, aiLimiter } from './middleware/rateLimiter';

// Webhooks (raw body — must mount before express.json())
import clerkWebhookRouter from './routes/webhooks/clerk';
import stripeWebhookRouter from './routes/webhooks/stripe';
import prismWebhooksRouter from './routes/prismWebhooks';

// Novu Framework workflows — served to Novu Cloud for orchestration
import { serve } from '@novu/framework/express';
import { allWorkflows } from './lib/novu/workflows';
import { createHmac } from 'crypto';

// Routes
import publicRouter from './routes/public';
import surveysRouter from './routes/surveys';
import responsesRouter from './routes/responses';
import insightsRouter from './routes/insights';
import reportsRouter from './routes/reports';
import templatesRouter from './routes/templates';
import aiRouter from './routes/ai';
import workflowsRouter from './routes/workflows';
import workflowCredentialsRouter from './routes/workflowCredentials';
import orgProfileRouter from './routes/orgProfile';
import orgsRouter from './routes/orgs';
import membersRouter from './routes/members';
import usersRouter from './routes/users';
import rolesRouter from './routes/roles';
import departmentsRouter from './routes/departments';
import groupsRouter from './routes/groups';
import tagsRouter from './routes/tags';
import surveyGroupsRouter from './routes/survey-groups';
import scimTokensRouter from './routes/scimTokens';
import ssoMappingsRouter from './routes/ssoMappings';
import seatsRouter from './routes/seats';
import auditLogsRouter from './routes/auditLogs';
import alertsRouter from './routes/alerts';
import dashboardRouter from './routes/dashboard';
import dashboardConfigsRouter from './routes/dashboard-configs';
import visualRouter from './routes/visual';
import notificationChannelsRouter from './routes/notificationChannels';
import scimRouter from './routes/scim';
import copilotRouter from './routes/copilot';
import runsRouter from './routes/runs';
import experienceRouter from './routes/experience';
import notificationsRouter from './routes/notifications';
import orgDashboardRouter from './routes/org-dashboard';
import { registerOrgDashboardStream } from './services/org-realtime.service';
import adminRouter from './routes/admin';
import crystalNovuRouter from './routes/crystal-novu';
import contactSegmentsRouter from './routes/contact-segments';
import contactSyncRouter from './routes/contact-sync';
import contactsRouter from './routes/contacts';
import cxCasesRouter from './routes/cx-cases';
import ownershipRouter from './routes/ownership';
import ontologyRouter from './routes/ontology';
import outreachRouter from './routes/outreach';
import outreachAnalyticsRouter, { frequencyCapsRouter } from './routes/outreach-analytics';
import suppressionRouter from './routes/suppression';
import billingRouter from './routes/billing';
import internalMeteringRouter from './routes/internal-metering';
import internalWorkflowsRouter from './routes/internal-workflows';
import supportRouter from './routes/support';
import adminSupportRouter from './routes/admin-support';
import prismRouter from './routes/prism';
import prismUploadsRouter from './routes/prismUploads';
import prismOauthRouter from './routes/prismOauth';

import { validateStartupConfig } from './lib/validateEnv';
// Startup config validation runs in start() below — presence + format/consistency + live
// connectivity (Postgres/Redis) — and fails fast before the server accepts traffic.
import { getPrismConfig, validatePrismProductionConfig } from './lib/prism/config';
// Prism per-environment config + production-readiness gate (see lib/prism/config.ts). Validated
// in start() below; in staging/production a fatal misconfig refuses boot (AGENTS_INTERNAL_KEY
// precedent). The worker + sync scheduler are started behind flags after the server is up.

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

// Production: restrict CORS to the configured frontend origin.
// Dev: allow all (origin: true reflects the request Origin header).
const corsOrigin = process.env.NODE_ENV === 'production'
  ? (process.env.ALLOWED_ORIGIN || false)
  : true;
app.use(cors({ origin: corsOrigin, credentials: true, exposedHeaders: ['X-Export-Fallback'] }));

// Clerk webhook needs the RAW body for Svix signature verification — mount it
// BEFORE express.json() so the JSON parser doesn't consume the stream.
app.use('/webhooks/clerk', express.raw({ type: '*/*' }), clerkWebhookRouter);
// Stripe webhook — raw body for signature verification, before express.json().
app.use('/webhooks/stripe', express.raw({ type: '*/*' }), stripeWebhookRouter);
// Prism CDC webhooks — raw body for HMAC verification (per-connection), before express.json().
app.use('/webhooks/prism', express.raw({ type: '*/*' }), prismWebhooksRouter);
// Prism file UPLOAD — RAW file bytes (req.body = Buffer); must mount BEFORE express.json()
// so the JSON parser doesn't consume the stream. requireAuth is applied inside the router.
app.use('/api/prism/uploads', express.raw({ type: '*/*', limit: '60mb' }), prismUploadsRouter);

// Novu Framework Bridge — serves workflow definitions to Novu Cloud.
// Must be mounted before express.json() as it handles its own body parsing.
// When NOVU_API_KEY is absent (dev mode), this is a no-op.
const novuHandler = process.env.NOVU_API_KEY
  ? serve({ workflows: allWorkflows })
  : null;

if (novuHandler) {
  app.use('/api/novu', novuHandler);
}

// Novu event webhooks (delivery, open, click) — raw body for HMAC verification
app.post('/webhooks/novu', express.raw({ type: '*/*' }), async (req, res) => {
  const secret = process.env.NOVU_SECRET_KEY;
  if (secret) {
    const sig = req.headers['novu-signature'] as string | undefined;
    const hash = createHmac('sha256', secret).update(req.body as Buffer).digest('hex');
    if (sig !== `sha256=${hash}`) { res.status(401).end(); return; }
  }
  try {
    const event = JSON.parse((req.body as Buffer).toString()) as Record<string, unknown>;
    const eventType = (event.type || event.status) as string | undefined;
    const workflowId = (event.workflowIdentifier || event.transactionId) as string | undefined;
    const subscriberId = (event.subscriber as Record<string, unknown> | undefined)?.subscriberId as string | undefined;
    const channel = event.channel as string | undefined;

    logger.info({ novuEvent: eventType, workflowId, subscriberId }, 'novu:webhook');

    // Persist delivery event for analytics
    if (eventType && subscriberId) {
      const VALID_EVENTS = new Set(['sent','delivered','opened','clicked','bounced','failed','unsubscribed']);
      const normalizedType = VALID_EVENTS.has(eventType) ? eventType : 'sent';
      await dbQuery(
        `INSERT INTO notification_delivery_events
           (novu_message_id, workflow_id, subscriber_id, channel, event_type, metadata)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT DO NOTHING`,
        [
          event.messageId as string ?? null,
          workflowId ?? null,
          subscriberId,
          channel ?? null,
          normalizedType,
          JSON.stringify({ raw: event }),
        ]
      ).catch((err: unknown) => {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'novu:webhook:persist_failed');
      });

      // On bounce: auto-suppress the email address
      if (normalizedType === 'bounced') {
        const email = (event.subscriber as Record<string, unknown> | undefined)?.email as string | undefined;
        if (email) {
          // Lazy import to avoid circular deps
          import('./lib/suppressionList').then(({ addSuppression }) => {
            addSuppression(
              'global', // org_id: need to resolve from subscriber_id; for now use a lookup
              'email',
              'bounce',
              'system',
              { email }
            ).catch(() => {});
          }).catch(() => {});
        }
      }

      // On unsubscribe: add to suppression list
      if (normalizedType === 'unsubscribed') {
        const email = (event.subscriber as Record<string, unknown> | undefined)?.email as string | undefined;
        if (email) {
          import('./lib/suppressionList').then(({ addSuppression }) => {
            addSuppression('global', 'email', 'unsubscribe', 'system', { email }).catch(() => {});
          }).catch(() => {});
        }
      }
    }

    res.status(200).json({ received: true });
  } catch {
    res.status(400).json({ error: 'Invalid payload' });
  }
});

// Default express.json() limit is 100kb — too small for Crystal turns, which
// resend the full insights/topics arrays plus the growing conversation_history
// on every message (see app/src/components/CrystalPanel.tsx). 5mb covers that
// with headroom while still bounding worst-case body size for every other route.
app.use(express.json({ limit: '5mb' }));
app.use(requestId);  // attach req.id before logging
app.use(httpLogger); // structured request logging + Prometheus HTTP metrics

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/public',      publicRouter);
app.use('/api/surveys',     apiLimiter, surveysRouter);
app.use('/api/surveys',     apiLimiter, responsesRouter);
app.use('/api/surveys',     apiLimiter, insightsRouter);
app.use('/api/insights',    apiLimiter, insightsRouter);
app.use('/api/reports',     apiLimiter, reportsRouter);
app.use('/api/templates',   apiLimiter, templatesRouter);
app.use('/api/ai',          apiLimiter, aiLimiter, aiRouter);
app.use('/api/workflows',   apiLimiter, workflowsRouter);
app.use('/api/workflow-credentials', apiLimiter, workflowCredentialsRouter);
app.use('/api/org-profile', apiLimiter, orgProfileRouter);
app.use('/api/orgs',        apiLimiter, orgsRouter);
app.use('/api/orgs/me',     apiLimiter, membersRouter);
app.use('/api/users',       apiLimiter, usersRouter);
app.use('/api/roles',       apiLimiter, rolesRouter);
app.use('/api/departments', apiLimiter, departmentsRouter);
app.use('/api/groups',      apiLimiter, groupsRouter);
app.use('/api/survey-tags', apiLimiter, tagsRouter);
app.use('/api/group-insights', apiLimiter, surveyGroupsRouter);
app.use('/api/scim-tokens', apiLimiter, scimTokensRouter);
app.use('/api/sso-mappings', apiLimiter, ssoMappingsRouter);
app.use('/api/seats',       apiLimiter, seatsRouter);
app.use('/api/billing',     apiLimiter, billingRouter);
app.use('/api/audit-logs',  apiLimiter, auditLogsRouter);
app.use('/api/alerts',      apiLimiter, alertsRouter);
app.use('/api/dashboard',   apiLimiter, dashboardRouter);
app.use('/api/dashboard-configs', apiLimiter, dashboardConfigsRouter);
app.use('/api/visual',      apiLimiter, visualRouter);
app.use('/api/notification-channels', apiLimiter, notificationChannelsRouter);
// SCIM 2.0 — separate namespace, bearer-token auth (NOT Clerk JWT), no apiLimiter.
app.use('/scim/v2',         scimRouter);
// Internal metering API — service-to-service (X-Internal-Key), not Clerk JWT, no apiLimiter.
app.use('/api/internal/metering', internalMeteringRouter);
// Internal workflow_signal receiver (CrystalOS → backend, Phase 3 AI triggers) —
// service-to-service (X-Internal-Key), not Clerk JWT, no apiLimiter.
app.use('/api/internal/workflows', internalWorkflowsRouter);
app.use('/api/copilot',     apiLimiter, copilotRouter);
app.use('/api/runs',        apiLimiter, runsRouter);
app.use('/api/experience',  apiLimiter, experienceRouter);
app.use('/api/notifications', apiLimiter, notificationsRouter);
app.use('/api/org',          apiLimiter, orgDashboardRouter);
registerOrgDashboardStream(app);
app.use('/api/admin',        apiLimiter, adminRouter);
app.use('/api/crystal-novu', apiLimiter, crystalNovuRouter);
// Tier 3: Contacts, Segments, Sync, CX Cases, Ownership, Ontology
// NOTE: /api/contacts/segments and /api/contacts/sync must be mounted BEFORE
// /api/contacts so Express matches the more-specific paths first.
app.use('/api/contacts/segments', apiLimiter, contactSegmentsRouter);
app.use('/api/contacts/sync',     apiLimiter, contactSyncRouter);
app.use('/api/contacts',          apiLimiter, contactsRouter);
app.use('/api/cases',             apiLimiter, cxCasesRouter);
app.use('/api/ownership-routes',  apiLimiter, ownershipRouter);
app.use('/api/ontology',          apiLimiter, ontologyRouter);
// NOTE: more-specific /api/outreach/* paths must be mounted BEFORE /api/outreach (more specific first)
app.use('/api/outreach/suppression',    apiLimiter, suppressionRouter);
app.use('/api/outreach/analytics',      apiLimiter, outreachAnalyticsRouter);
app.use('/api/outreach/frequency-caps', apiLimiter, frequencyCapsRouter);
app.use('/api/outreach',                apiLimiter, outreachRouter);
// Support system — public docs + Crystal support + admin pipeline
app.use('/api/support',       apiLimiter, supportRouter);
app.use('/api/admin-support', apiLimiter, adminSupportRouter);
// Prism one-click OAuth — start (authed, inside router) + callback (PUBLIC, validated by
// `state`). Mounted BEFORE /api/prism so the more-specific /api/prism/oauth path matches first.
app.use('/api/prism/oauth',   apiLimiter, prismOauthRouter);
// Prism — data ingestion / migration engine API (connections, jobs, mapping, dry-run, recon)
app.use('/api/prism',         apiLimiter, prismRouter);

// ── Observability ─────────────────────────────────────────────────────────────
// Readiness: can this instance serve traffic? Postgres is the only hard dependency;
// Redis is soft (the app fails open without it), so a Redis outage is reported but does
// not fail the check. Used by load balancers / orchestrators to route traffic.
async function readiness(): Promise<Record<string, string>> {
  const health: Record<string, string> = { status: 'ok', version: '2.0.0', backend: 'local' };
  try {
    await dbQuery('SELECT 1');
    health.db = 'ok';
  } catch {
    health.db = 'error';
    health.status = 'degraded';   // DB down → not ready (503)
  }
  try {
    const r = getRedisClient();
    health.redis = !r ? 'not_configured' : (r.status === 'ready' ? 'ok' : 'unavailable');
  } catch {
    health.redis = 'error';       // soft — does not flip overall status
  }
  return health;
}

app.get('/api/health', async (_req, res) => {
  const health = await readiness();
  res.status(health.status === 'ok' ? 200 : 503).json(health);
});

// Readiness probe (DB required) — alias for orchestrators that distinguish ready vs live.
app.get('/api/health/ready', async (_req, res) => {
  const health = await readiness();
  res.status(health.status === 'ok' ? 200 : 503).json(health);
});

// Liveness probe — process is up; never touches dependencies (so a DB blip doesn't trigger a restart loop).
app.get('/api/health/live', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/metrics', async (req, res) => {
  // Prometheus scrapes from localhost only — block external access in production
  if (process.env.NODE_ENV === 'production') {
    const ip = req.ip ?? req.socket?.remoteAddress ?? '';
    if (!ip.includes('127.0.0.1') && !ip.includes('::1') && !ip.includes('::ffff:127.')) {
      return res.status(403).end();
    }
  }
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ── Error handlers ────────────────────────────────────────────────────────────
// Sentry must come before the generic handler; no-ops when DSN is not set
Sentry.setupExpressErrorHandler(app);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error({ err: err.message, stack: err.stack, route: req.path, requestId: req.id }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3001;
let server: ReturnType<typeof app.listen> | undefined;

async function start(): Promise<void> {
  // Fail fast: required keys present + well-formed, and Postgres/Redis actually reachable —
  // before we accept a single request.
  await waitForDb();
  await validateStartupConfig({ connectivity: true });

  // Prism production-readiness gate. In staging/production a fatal misconfig (local upload/secrets
  // in prod, missing Redis/OAuth URLs, default AGENTS_INTERNAL_KEY) refuses boot — mirrors the
  // AGENTS_INTERNAL_KEY prod-validation precedent. In development this is always [] (never crashes dev).
  const prismCfg = getPrismConfig();
  const prismFatal = validatePrismProductionConfig(prismCfg);
  if (prismFatal.length) {
    for (const item of prismFatal) logger.error({}, `prism config: ${item}`);
    throw new Error(`Prism is not production-ready (APP_ENV=${prismCfg.appEnv}):\n  - ${prismFatal.join('\n  - ')}`);
  }

  server = app.listen(PORT, () => {
    const clerkKey = resolveClerkSecretKey();
    const _devMode = !clerkKey;
    logger.info(`API  → http://localhost:${PORT}  (backend: local/postgres)`);
    logger.info(`Auth → ${_devMode ? 'DEV MODE (no valid CLERK_SECRET_KEY — all requests as dev-user/dev-org)' : 'Clerk JWT'}`);
    if (_devMode) {
      if (process.env.CLERK_SECRET_KEY?.trim()) {
        logger.warn('CLERK_SECRET_KEY is set but invalid or a placeholder — running in DEV MODE');
      } else {
        logger.warn('Running in DEV MODE — set CLERK_SECRET_KEY to enable real authentication');
      }
    }
    logger.info(`CORS → ${corsOrigin === true ? 'all origins (dev)' : (corsOrigin || 'BLOCKED — set ALLOWED_ORIGIN')}`);
    logger.info(`Agents env → AGENTS_ENV=${process.env.AGENTS_ENV ?? 'dev (default)'}`);
    logger.info(`Metrics → http://localhost:${PORT}/api/metrics`);

    // Dev convenience: run the notification Event Engine in-process. In production
    // it runs as the separate `event-engine` service (npm run start:event-engine).
    if (process.env.ENABLE_EVENT_ENGINE === 'true') {
      import('./eventEngine/processor')
        .then((mod) => mod.start({ consumer: `inproc-${process.pid}` }))
        .then(() => logger.info('Event Engine → running in-process (ENABLE_EVENT_ENGINE=true)'))
        .catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.error({ err: error.message }, 'Event Engine failed to start');
        });
    }

    // ── Prism ingestion engine ──────────────────────────────────────────────
    // In dev the worker + sync scheduler run in-process (default on). In prod they run as a
    // dedicated Fly.io `worker` process group — there, the web instances set PRISM_WORKER_ENABLED
    // /PRISM_SYNC_ENABLED=false and only the worker process leaves them on. Dynamic imports so a
    // missing module / disabled flag never blocks the API from serving traffic.
    logger.info(
      { backend: prismCfg.upload.backend, secrets: prismCfg.secretsBackend, worker: prismCfg.worker.enabled, sync: prismCfg.worker.syncEnabled },
      `Prism → APP_ENV=${prismCfg.appEnv}`,
    );
    if (prismCfg.worker.enabled) {
      import('./lib/prism/worker')
        .then((mod) => mod.startPrismWorker())
        .then(() => logger.info(`Prism worker → running (max concurrent extract: ${prismCfg.worker.maxConcurrentExtract})`))
        .catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.error({ err: error.message }, 'Prism worker failed to start');
        });
    }
    if (prismCfg.worker.syncEnabled) {
      import('./lib/prism/sync/scheduler')
        .then((mod) => mod.startPrismSyncScheduler())
        .then(() => logger.info(`Prism sync scheduler → running (poll interval: ${prismCfg.worker.syncPollIntervalS}s)`))
        .catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.error({ err: error.message }, 'Prism sync scheduler failed to start');
        });
    }
  });
}

start().catch((err: unknown) => {
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error({ err: error.message }, 'startup aborted — fix the configuration above and restart');
  process.exit(1);
});

// Graceful shutdown — PM2 sends SIGTERM on `pm2 reload`, SIGINT on Ctrl+C
const shutdown = (sig: string): void => {
  logger.info({ sig }, 'shutdown signal received');
  if (!server) { process.exit(0); }
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => { logger.error('shutdown timeout — forcing exit'); process.exit(1); }, 30_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
