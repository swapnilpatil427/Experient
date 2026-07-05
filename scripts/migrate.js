#!/usr/bin/env node
/**
 * Incremental migration runner for local dev.
 *
 * Tracks applied migrations in a schema_migrations table.
 * Safe to run repeatedly — skips already-applied files.
 * Handles first-run: if the DB was bootstrapped by Docker (surveys table
 * exists but schema_migrations doesn't), pre-marks the Dockerfile migrations
 * as applied so they are not re-run destructively.
 */
'use strict';

// pg lives in backend/node_modules; fall back to root node_modules if installed there
let Client;
try { ({ Client } = require('pg')); }
catch { ({ Client } = require('../backend/node_modules/pg')); }
const fs         = require('fs');
const path       = require('path');

// Root .env is the source of truth (same as backend / CrystalOS).
const rootEnv = path.join(__dirname, '../.env');
if (fs.existsSync(rootEnv)) {
  try { require('dotenv').config({ path: rootEnv }); }
  catch { require('../backend/node_modules/dotenv').config({ path: rootEnv }); }
}

const DB_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:postgres@localhost:5432/xperiq';

const LEGACY_DB_NAME = 'experient';

function parseDbUrl(url) {
  const u = new URL(url);
  const dbName = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const maint = new URL(url);
  maint.pathname = '/postgres';
  return { dbName, maintUrl: maint.toString() };
}

function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`invalid database name: ${name}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

async function ensureDatabase(retries = 15, delayMs = 2000) {
  const { dbName, maintUrl } = parseDbUrl(DB_URL);
  for (let i = 1; i <= retries; i++) {
    const client = new Client({ connectionString: maintUrl });
    try {
      await client.connect();
      const { rows } = await client.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [dbName]
      );
      if (rows.length === 0) {
        const { rows: legacy } = await client.query(
          'SELECT 1 FROM pg_database WHERE datname = $1',
          [LEGACY_DB_NAME]
        );
        if (legacy.length > 0 && dbName === 'xperiq') {
          await client.query(`ALTER DATABASE ${quoteIdent(LEGACY_DB_NAME)} RENAME TO ${quoteIdent(dbName)}`);
          console.log(`[migrate] ✓ renamed database ${LEGACY_DB_NAME} → ${dbName}`);
        } else {
          await client.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
          console.log(`[migrate] ✓ created database ${dbName}`);
        }
      }
      await client.end();
      return;
    } catch (err) {
      await client.end().catch(() => {});
      if (i === retries) throw err;
      process.stdout.write(`[migrate] waiting for postgres (${i}/${retries})…\r`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// Migrations that Docker applies on a fresh DB via docker-entrypoint-initdb.d.
// Pre-mark these as done when we detect an existing bootstrapped DB.
const DOCKER_BOOTSTRAPPED = [
  '20240101000000_initial',
  '20240514000000_agents',
  '20240515000000_agents_compliance',
];

// For migrations that may have been applied outside the runner (manually, or via
// a previous Docker image), check a fingerprint query. If the query returns a row,
// the migration was already applied — mark it done without re-running it.
const FINGERPRINTS = {
  '20240516000000_insights':
    `SELECT to_regclass('public.insight_audit_log') AS exists`,
  '20240517000000_surveys_v2':
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='surveys' AND column_name='insight_schedule_enabled' LIMIT 1`,
  '20240518000000_insights_v2':
    `SELECT to_regclass('public.survey_topics') AS exists`,

  // Enterprise CrystalOS redesign — tables that may have been created manually
  '20260623000001_enterprise_brand_context':
    `SELECT to_regclass('public.brands') AS exists`,
  '20260623000002_crystal_telemetry':
    `SELECT to_regclass('public.crystal_turn_events') AS exists`,
  '20260623000003_product_signals':
    `SELECT to_regclass('public.crystal_product_signals') AS exists`,
  '20260623000004_skill_quality':
    `SELECT to_regclass('public.skill_examples') AS exists`,
  '20260623000005_bug_tracking':
    `SELECT to_regclass('public.crystal_event_queue') AS exists`,
  '20260623000006_feedback_scale':
    `SELECT to_regclass('public.feedback_hourly_rollups') AS exists`,
  '20260623000007_skill_variants':
    `SELECT to_regclass('public.skill_example_refreshes') AS exists`,
  '20260623000008_gap_clusters':
    `SELECT to_regclass('public.capability_gap_clusters') AS exists`,
  '20260626000001_insight_audit_log':
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='insight_audit_log' AND column_name='org_id' LIMIT 1`,
};

async function connectWithRetry(retries = 15, delayMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    const client = new Client({ connectionString: DB_URL });
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => {});
      if (i === retries) throw err;
      process.stdout.write(`[migrate] waiting for postgres (${i}/${retries})…\r`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  await ensureDatabase();
  const client = await connectWithRetry();

  try {
    // Ensure tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Detect Docker-bootstrapped DB: surveys exists but tracking table was just created
    const { rows: surveyRows } = await client.query(`
      SELECT to_regclass('public.surveys') AS t
    `);
    const { rows: migRows } = await client.query(
      'SELECT COUNT(*)::int AS n FROM schema_migrations'
    );
    if (surveyRows[0].t && migRows[0].n === 0) {
      // Fresh schema_migrations on an already-bootstrapped DB — pre-mark Docker migrations
      for (const v of DOCKER_BOOTSTRAPPED) {
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
          [v]
        );
      }
    }

    // Determine applied set
    const { rows: applied } = await client.query('SELECT version FROM schema_migrations');
    const done = new Set(applied.map(r => r.version));

    // Collect and sort migration files
    const migrationsDir = path.join(__dirname, '../supabase/migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      const version = path.basename(file, '.sql');
      if (done.has(version)) continue;

      // Check fingerprint — if the objects this migration creates already exist,
      // the migration was applied outside the runner. Mark it done and skip.
      if (FINGERPRINTS[version]) {
        const { rows } = await client.query(FINGERPRINTS[version]);
        if (rows.length > 0 && (rows[0].exists || rows[0].column_name)) {
          await client.query(
            'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
            [version]
          );
          console.log(`[migrate] ✓ ${file} (already applied — fingerprinted)`);
          continue;
        }
      }

      process.stdout.write(`[migrate] → ${file}\n`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      // CREATE INDEX CONCURRENTLY / REFRESH MATERIALIZED VIEW CONCURRENTLY cannot run inside a
      // transaction block. Migrations that need CONCURRENTLY (org-dashboard's
      // idx_insights_survey_layer_trust / idx_responses_org_submitted) are run as a bare
      // statement instead of being wrapped in BEGIN/COMMIT like every other migration. Every
      // such statement uses IF NOT EXISTS, so a partial failure (index created, ledger insert
      // below it failing) is safely idempotent on retry — no ROLLBACK is possible or needed
      // once the CONCURRENTLY statement itself has committed.
      // Strip line comments before testing — several migrations mention "CONCURRENTLY" only in
      // prose comments (explaining why a *different* file needs it), which must not trip this.
      const sqlNoComments = sql.replace(/--.*$/gm, '');
      const isConcurrent = /\bCONCURRENTLY\b/i.test(sqlNoComments);
      if (isConcurrent) {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
          [version]
        );
        ran++;
      } else {
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (version) VALUES ($1)',
            [version]
          );
          await client.query('COMMIT');
          ran++;
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file} failed: ${err.message}`);
        }
      }
    }

    if (ran === 0) console.log('[migrate] ✓ already up to date');
    else          console.log(`[migrate] ✓ applied ${ran} migration(s)`);

  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error(`[migrate] ✗ ${err.message}`);
  process.exit(1);
});
