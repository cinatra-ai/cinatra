-- 0002_drop-agent-templates-durable.sql
--
-- Issue #84 (remove or reinstate orphaned/dead agent code paths):
-- drop the dead `agent_templates.durable` column. The column was added as a
-- "distributed-tier flag (BullMQ)" but no routing or execution code ever
-- consulted it — every writer only ever persisted the default `false`
-- (createAgentTemplate default, the external-template insert, the CLI
-- installer), so no user-land data is lost by dropping it.
--
-- The statement is idempotent and also rides the bootstrap DDL
-- (buildCreateStoreSchemaQueries in src/lib/drizzle-store.ts, which replaced
-- its former ADD COLUMN with the same guarded DROP); applying this file by
-- hand and then booting (or vice versa) is safe.
--
-- Apply:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v schema=cinatra \
--     -f migrations/0002_drop-agent-templates-durable.sql

ALTER TABLE :"schema"."agent_templates"
  DROP COLUMN IF EXISTS durable;
