// Org-settings CRUD for the per-org workflow connector credentials vault.
// Mounted at /api/workflow-credentials. Secrets are write-only: GET never returns
// decrypted values, only which connectors are configured + non-secret metadata
// (mirrors routes/notificationChannels.ts's redacted-read pattern).
import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/requirePermission';
import { connectorTestLimiter } from '../middleware/rateLimiter';
import { validate } from '../lib/validate';
import { serverError, clientError } from '../lib/httpError';
import { CONNECTORS, isConnectorName, getCredentials, setCredentials, deleteCredentials, getConnectorStatuses } from '../lib/workflowCredentials';
import { testJira, testSalesforce, testServicenow, testZendesk, testSlack } from '../lib/connectorTest';

const router = express.Router();

const putSchema = z.object({
  data: z.record(z.string(), z.any()),
});

// Test-connection body is optional — omitted `data` means "test what's already
// saved" (vault row, falling back to shared env vars); present `data` means
// "test these candidate values without saving them" (test-before-save).
const testSchema = z.object({
  data: z.record(z.string(), z.any()).optional(),
});

// GET /api/workflow-credentials — settings-page-ready status for ALL connectors
// (jira/salesforce/servicenow/zendesk/slack/webhook), each resolved to exactly
// one of 'org' | 'shared' | 'none' so the UI can render "Connected (org)" /
// "Using shared default" / "Not connected" without a second call. Slack is
// included here (backed by notification_channels, not this vault) so the
// frontend gets one uniform response for all 5 user-facing connectors — see
// docs/automation-hub/INTEGRATIONS_BACKEND_REVIEW.md §1/§2 for the full
// reasoning (and the tradeoff against a client-side-merge alternative).
// Gated by workflows:manage — this is org-settings (which third-party integrations
// are wired up), same permission as ownership.ts/cx-cases.ts routes in this domain.
router.get('/', requireAuth, requirePermission('workflows:manage'), async (req: Request, res: Response): Promise<void> => {
  try {
    const connectors = await getConnectorStatuses(req.orgId);
    res.json({ connectors });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// PUT /api/workflow-credentials/:connector — set/update an org's credentials for a connector.
router.put('/:connector', requireAuth, requirePermission('workflows:manage'), validate(putSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { connector } = req.params;
    if (!isConnectorName(connector)) {
      clientError(res, 400, `Unknown connector. Must be one of: ${CONNECTORS.join(', ')}`);
      return;
    }
    await setCredentials(req.orgId, connector, req.body.data);
    res.status(200).json({ connector, configured: true });
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (error.message.includes('WORKFLOW_CREDENTIALS_KEY')) {
      clientError(res, 503, 'Credentials vault is not configured on this deployment');
      return;
    }
    serverError(res, error);
  }
});

// POST /api/workflow-credentials/:connector/test — validate credentials with a
// real, read-only, no-side-effect API call (Jira/Salesforce/ServiceNow/Zendesk)
// or a real test message (Slack — incoming webhooks have no side-effect-free
// auth-check verb, see docs/automation-hub/INTEGRATIONS_BACKEND_REVIEW.md §3).
// Never persists anything. Accepts optional `{ data }` so a user can test values
// they just typed before hitting Save; when omitted, falls back to the saved
// vault row, then the deployment's shared env vars (same precedence
// connectors.ts uses for real actions). `webhook` has no test — its vault entry
// is only an HMAC-signing secret with no fixed endpoint to validate against.
//
// Tighter rate limit than the rest of this router (connectorTestLimiter, 10/org/
// 15min) since every call makes a real outbound request to a third party — see
// INTEGRATIONS_BACKEND_REVIEW.md §5.
router.post('/:connector/test', requireAuth, requirePermission('workflows:manage'), connectorTestLimiter, validate(testSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { connector } = req.params;
    if (!isConnectorName(connector)) {
      clientError(res, 400, `Unknown connector. Must be one of: ${CONNECTORS.join(', ')}`);
      return;
    }
    if (connector === 'webhook') {
      clientError(res, 400, 'webhook credentials have no test — there is no fixed endpoint to validate; the signing secret is exercised when a workflow\'s notify.webhook action actually runs');
      return;
    }

    // Each test*() accepts a loosely-typed "candidate fields" object (test-before-
    // save may send a partial/in-progress form); the functions themselves resolve
    // missing fields from the vault / env fallback, so a plain cast here is safe —
    // they never trust field presence, only field values when present.
    const data = req.body.data as Record<string, unknown> | undefined;
    let result;
    switch (connector) {
      case 'jira': result = await testJira(req.orgId, data); break;
      case 'salesforce': result = await testSalesforce(req.orgId, data); break;
      case 'servicenow': result = await testServicenow(req.orgId, data); break;
      case 'zendesk': result = await testZendesk(req.orgId, data); break;
      case 'slack': result = await testSlack(req.orgId, data); break;
    }
    res.status(200).json(result);
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// DELETE /api/workflow-credentials/:connector — remove an org's credentials for a connector.
router.delete('/:connector', requireAuth, requirePermission('workflows:manage'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { connector } = req.params;
    if (!isConnectorName(connector)) {
      clientError(res, 400, `Unknown connector. Must be one of: ${CONNECTORS.join(', ')}`);
      return;
    }
    const deleted = await deleteCredentials(req.orgId, connector);
    if (!deleted) { clientError(res, 404, 'No credentials configured for that connector'); return; }
    res.json({ success: true });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// Internal helper (not a route) so tests / other code can assert a specific connector's
// presence without exposing decrypted values over HTTP.
export async function isConnectorConfigured(orgId: string, connector: string): Promise<boolean> {
  if (!isConnectorName(connector)) return false;
  return (await getCredentials(orgId, connector)) != null;
}

export default router;
