// Regression coverage for POST /api/internal/workflows/signal — the receiving
// side of the workflow_signal seam from CrystalOS (Nina, Wave 3; see
// docs/automation-hub/WORKFLOW_SIGNAL_CONTRACT.md). Service-to-service only,
// gated by requireInternalKey (mirrors routes/internal-metering.ts's pattern),
// so this suite mocks the internal-key check and lib/workflowQueue.ts's
// publishWorkflowTrigger to verify routing/validation, not Redis itself.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inject from 'light-my-request';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const INTERNAL_KEY_PATH = _require.resolve(resolve(__dirname, '../middleware/internalKey'));
const QUEUE_PATH        = _require.resolve(resolve(__dirname, '../lib/workflowQueue'));
const ROUTER_PATH       = _require.resolve(resolve(__dirname, '../routes/internal-workflows'));

function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }

let publishWorkflowTriggerMock;
let internalKeyValid;

function buildApp() {
  _require.cache[INTERNAL_KEY_PATH] = fakeMod(INTERNAL_KEY_PATH, {
    requireInternalKey: (req, res, next) => {
      if (!internalKeyValid) { res.status(401).json({ error: 'invalid_internal_key' }); return; }
      next();
    },
  });
  _require.cache[QUEUE_PATH] = fakeMod(QUEUE_PATH, { publishWorkflowTrigger: publishWorkflowTriggerMock });
  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express();
  app.use('/api/internal/workflows', router.default || router);
  return app;
}

async function api(app, method, url, body = null) {
  const opts = { method, url };
  if (body !== null) { opts.payload = JSON.stringify(body); opts.headers = { 'content-type': 'application/json' }; }
  const res = await inject(app, opts);
  return { status: res.statusCode, body: res.json() };
}

const VALID_SIGNAL = {
  org_id: 'o1',
  signal_type: 'sentiment_spike',
  confidence: 0.91,
  payload: { survey_title: 'Q3 CSAT' },
  survey_id: 's1',
  detected_at: '2026-07-01T12:00:00.000Z',
  source_run_id: 'run-1',
};

beforeEach(() => {
  internalKeyValid = true;
  publishWorkflowTriggerMock = vi.fn(async () => 'stream-id-123');
});

describe('POST /api/internal/workflows/signal', () => {
  it('rejects without a valid X-Internal-Key (401)', async () => {
    internalKeyValid = false;
    const { status } = await api(buildApp(), 'POST', '/api/internal/workflows/signal', VALID_SIGNAL);
    expect(status).toBe(401);
    expect(publishWorkflowTriggerMock).not.toHaveBeenCalled();
  });

  it('routes a valid sentiment_spike signal into publishWorkflowTrigger with the mapped trigger type', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/internal/workflows/signal', VALID_SIGNAL);
    expect(status).toBe(202);
    expect(body).toEqual({ accepted: true, published: true });

    expect(publishWorkflowTriggerMock).toHaveBeenCalledTimes(1);
    const [call] = publishWorkflowTriggerMock.mock.calls[0];
    expect(call.orgId).toBe('o1');
    expect(call.triggerType).toBe('crystal.sentiment_spike');
    expect(call.event.type).toBe('crystal.sentiment_spike');
    expect(call.event.severity).toBe('high'); // confidence 0.91 >= 0.85
    expect(call.event.payload).toMatchObject({
      survey_title: 'Q3 CSAT',
      signal_type: 'sentiment_spike',
      confidence: 0.91,
      survey_id: 's1',
      detected_at: '2026-07-01T12:00:00.000Z',
      source_run_id: 'run-1',
    });
  });

  it('maps new_theme_detected -> crystal.new_theme_detected', async () => {
    const { status } = await api(buildApp(), 'POST', '/api/internal/workflows/signal', {
      ...VALID_SIGNAL, signal_type: 'new_theme_detected', confidence: 0.7,
    });
    expect(status).toBe(202);
    const [call] = publishWorkflowTriggerMock.mock.calls[0];
    expect(call.triggerType).toBe('crystal.new_theme_detected');
    expect(call.event.severity).toBe('medium'); // 0.6 <= 0.7 < 0.85
  });

  it('maps anomaly_detected -> crystal.anomaly_detected', async () => {
    const { status } = await api(buildApp(), 'POST', '/api/internal/workflows/signal', {
      ...VALID_SIGNAL, signal_type: 'anomaly_detected', confidence: 0.4,
    });
    expect(status).toBe(202);
    const [call] = publishWorkflowTriggerMock.mock.calls[0];
    expect(call.triggerType).toBe('crystal.anomaly_detected');
    expect(call.event.severity).toBe('low'); // < 0.6
  });

  it('reports published:false when Redis is unavailable (publishWorkflowTrigger returns null) without failing the request', async () => {
    publishWorkflowTriggerMock = vi.fn(async () => null);
    const { status, body } = await api(buildApp(), 'POST', '/api/internal/workflows/signal', VALID_SIGNAL);
    expect(status).toBe(202);
    expect(body).toEqual({ accepted: true, published: false });
  });

  it('rejects a malformed signal — missing org_id (400)', async () => {
    const { org_id, ...rest } = VALID_SIGNAL;
    const { status } = await api(buildApp(), 'POST', '/api/internal/workflows/signal', rest);
    expect(status).toBe(400);
    expect(publishWorkflowTriggerMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed signal — unknown signal_type (400)', async () => {
    const { status } = await api(buildApp(), 'POST', '/api/internal/workflows/signal', { ...VALID_SIGNAL, signal_type: 'made_up_signal' });
    expect(status).toBe(400);
    expect(publishWorkflowTriggerMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed signal — confidence out of [0,1] range (400)', async () => {
    const { status } = await api(buildApp(), 'POST', '/api/internal/workflows/signal', { ...VALID_SIGNAL, confidence: 1.5 });
    expect(status).toBe(400);
    expect(publishWorkflowTriggerMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed signal — confidence missing (400)', async () => {
    const { confidence, ...rest } = VALID_SIGNAL;
    const { status } = await api(buildApp(), 'POST', '/api/internal/workflows/signal', rest);
    expect(status).toBe(400);
  });

  it('defaults payload to {} when absent', async () => {
    const { org_id, signal_type, confidence } = VALID_SIGNAL;
    const { status } = await api(buildApp(), 'POST', '/api/internal/workflows/signal', { org_id, signal_type, confidence });
    expect(status).toBe(202);
    const [call] = publishWorkflowTriggerMock.mock.calls[0];
    expect(call.event.payload.signal_type).toBe(signal_type);
  });
});
