/**
 * Internal Workflow Signal API — the receiving side of the `workflow_signal`
 * seam between CrystalOS's insight pipeline and the backend's trigger evaluator
 * (docs/automation-hub/WORKFLOW_SIGNAL_CONTRACT.md; TEAM.md's Nina Reeves mandate:
 * "Define the workflow_signal contract... Act as integration owner for Phase 3
 * (AI triggers) — sign off before CrystalOS → backend seam ships").
 *
 * Service-to-service only (X-Internal-Key via requireInternalKey — mirrors
 * routes/internal-metering.ts's pattern exactly, the established precedent for
 * "CrystalOS calls back into Node"). There is no end-user Clerk session on this
 * call, so org_id travels explicitly in the body rather than via req.orgId.
 *
 *   POST /api/internal/workflows/signal
 *     { org_id, signal_type: 'sentiment_spike'|'new_theme_detected'|'anomaly_detected',
 *       confidence, payload?, survey_id?, detected_at?, source_run_id? }
 *     → 202 { accepted: true, published: boolean }
 *
 * Routes into the existing async trigger machinery via
 * lib/workflowQueue.ts::publishWorkflowTrigger — NOT the synchronous
 * lib/workflowEngine.ts::runWorkflowsForEvent — because this is an externally
 * originated call from another service: publishing to the Redis Streams queue
 * and returning immediately means a slow/failing workflow run can never hang or
 * fail this HTTP response back to CrystalOS (same rationale workflowQueue.ts's
 * header comment already documents for the Event Engine's own inline-call
 * problem — this seam has the identical shape, just with CrystalOS as the
 * caller instead of eventEngine/processor.ts).
 */
import express from 'express';
import type { Request, Response } from 'express';
import { requireInternalKey } from '../middleware/internalKey';
import { validate } from '../lib/validate';
import { workflowSignalSchema, type WorkflowSignalInput } from '../schemas/workflows';
import { serverError } from '../lib/httpError';
import { publishWorkflowTrigger } from '../lib/workflowQueue';
import type { TriggerEvent } from '../lib/workflowEngine';
import logger from '../lib/logger';

const router = express.Router();
router.use(express.json());
router.use(requireInternalKey);

// Maps a workflow_signal's signal_type to the workflowRegistry.ts trigger type
// it fires (see lib/workflowRegistry.ts's TRIGGERS — crystal.sentiment_spike /
// crystal.new_theme_detected / crystal.anomaly_detected).
const SIGNAL_TO_TRIGGER_TYPE: Record<WorkflowSignalInput['signal_type'], string> = {
  sentiment_spike:     'crystal.sentiment_spike',
  new_theme_detected:  'crystal.new_theme_detected',
  anomaly_detected:    'crystal.anomaly_detected',
};

router.post('/signal', validate(workflowSignalSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as WorkflowSignalInput;
    const triggerType = SIGNAL_TO_TRIGGER_TYPE[body.signal_type];

    const event: TriggerEvent = {
      type:     triggerType,
      severity: body.confidence >= 0.85 ? 'high' : body.confidence >= 0.6 ? 'medium' : 'low',
      payload:  {
        ...body.payload,
        signal_type:   body.signal_type,
        confidence:    body.confidence,
        survey_id:     body.survey_id ?? null,
        detected_at:   body.detected_at ?? new Date().toISOString(),
        source_run_id: body.source_run_id ?? null,
      },
    };

    const streamId = await publishWorkflowTrigger({
      orgId: body.org_id,
      triggerType,
      event,
    });

    logger.info(
      { orgId: body.org_id, signalType: body.signal_type, triggerType, confidence: body.confidence, streamId },
      'workflow_signal_received',
    );
    res.status(202).json({ accepted: true, published: streamId !== null });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { route: 'internal-workflows:signal' });
  }
});

export default router;
