# @cinatra-ai/dashboards

Cinatra-specific glue for the Dashboards Platform. Owns:

- Postgres tables and migrations for `dashboards` and `dashboard_revisions`
- Single mutation service that emits global `audit_events`
- MCP handlers (`dashboards_list`, `dashboards_get`, `dashboards_create`, `dashboards_update`, `dashboards_archive`, plus cube/AI primitives)
- Better-auth session -> Cinatra `SecurityContext` binding
- Server-side route helpers and screens (`/dashboards`, `/dashboards/[id]`, `/configuration/dashboards`)
- Audit-event integration
- BullMQ provider wiring for async AI dashboard generation

May import from `@cinatra-ai/sdk-dashboard`. The reverse is forbidden - see `packages/sdk-dashboard/README.md`.

This package is **not** structured for extraction. Cinatra concepts (better-auth, BullMQ, audit_events, Drizzle schema, MCP actor context) live here.

## Storage envelope history

Existing analytics dashboards (legacy `apiVersion` rows, revisions, and seeds) were normalized to the current dashboards storage envelope by a single one-time, no-backward-compat data migration. The migration rewrites every legacy row into a registry-valid analytics envelope and aborts the transaction if any row would land invalid. See `#327` for the rationale and the proof record.
