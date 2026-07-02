-- Per-org workflow connector credentials vault. Today Jira/Salesforce/ServiceNow/
-- Zendesk connectors (backend/src/lib/connectors.ts) read SHARED process.env vars —
-- one account for the whole deployment. This table lets each org configure its own
-- credentials; encrypted at the application layer (AES-256-GCM, WORKFLOW_CREDENTIALS_KEY
-- in backend/src/lib/workflowCredentials.ts) before it ever reaches Postgres. Connectors
-- try org-level credentials first, then fall back to the legacy shared env vars — zero
-- breaking change for orgs that never configure per-org credentials.
CREATE TABLE IF NOT EXISTS workflow_connector_credentials (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         TEXT        NOT NULL,
  connector      TEXT        NOT NULL CHECK (connector IN ('jira', 'salesforce', 'servicenow', 'zendesk', 'slack', 'webhook')),
  encrypted_blob JSONB       NOT NULL,  -- { iv, tag, ciphertext } — AES-256-GCM, app-layer encrypted; never plaintext
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, connector)
);
CREATE INDEX IF NOT EXISTS idx_workflow_connector_credentials_org ON workflow_connector_credentials(org_id);
