/**
 * THE STORE'S NON-PAYLOAD ROW SHAPES, AS THEIR OWN SLICE (cinatra#3046, leg 15).
 *
 * Two row types lifted out of `drizzle-store.ts` whole and unchanged: the skill
 * package's identity tuple and the extension lifecycle audit row. Both describe
 * a table that is NOT a JSON-payload table, so both are hand-written shapes with
 * no query, no schema builder and no drizzle import behind them — which is what
 * makes them liftable. `drizzle-store.ts` re-exports both, so `@/lib/drizzle-store`
 * stays the import path every caller already uses.
 *
 * WHY THEY MOVED. The file-size ratchet holds `drizzle-store.ts` at a ceiling
 * that may only ever be LOWERED, and this change adds a line of bootstrap DDL to
 * it (the produced-review park's column). The gate's own instruction is the road
 * taken here: extract a thin facade plus a vertical slice and lower the ceiling,
 * never raise it.
 */

import type { BindingScope, OwnerScope, SourceKind } from "@cinatra-ai/skills";

// Import the literal unions from @cinatra-ai/skills so a
// typo (e.g. "workspaces" instead of "workspace") fails typecheck instead of
// hitting `skill_pkg_owner_scope_chk` at runtime mid-transaction.
export type SkillPackageIdentity = {
  owner_scope: OwnerScope;
  owner_id: string | null;
  binding_scope: BindingScope;
  source_kind: SourceKind;
  vendor: string | null;
  package: string | null;
  agent_template_id: string | null;
  skill_slug: string;
};

export type ExtensionLifecycleAuditRow = {
  id: string;
  actorId: string;
  actorType: string;
  orgId: string | null;
  operation: string;
  packageName: string;
  packageVersion: string | null;
  destroyedRowSnapshot: unknown;
  danglingReferences: unknown;
  reason: string | null;
};
