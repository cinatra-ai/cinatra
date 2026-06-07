# @cinatra-ai/dashboards

Cinatra-specific glue for the Dashboards Platform. Owns:

- Postgres tables and migrations for `dashboards` and `dashboard_revisions`
- Single mutation service that emits global `audit_events`
- MCP handlers (`dashboards_list`, `dashboards_get`, `dashboards_create`, `dashboards_update`, `dashboards_archive`, plus cube/AI primitives)
- Better-auth session -> Cinatra `SecurityContext` binding
- Server-side route helpers and screens (`/dashboards`, `/dashboards/[id]`, `/configuration/dashboards`)
- Audit-event integration
- BullMQ provider wiring for async AI dashboard generation

May import from `@cinatra-ai/sdk-dashboard`. The reverse is forbidden - see `packages/sdk-dashboard/README.md` and ADR 0044.

This package is **not** structured for extraction. Cinatra concepts (better-auth, BullMQ, audit_events, Drizzle schema, MCP actor context) live here.
