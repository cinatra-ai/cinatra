// ---------------------------------------------------------------------------
// Server-side `cinatra status` payload (cinatra#255 G2).
//
// Re-homes the read that `cinatra status` performs directly against Postgres
// today (the published @cinatra-ai/cinatra CLI's `gatherStatus`) onto the
// instance, so the published `cinatra` bin can fetch the same JSON over an
// authenticated API instead of needing the DB connection string.
//
// The returned shape MUST stay byte-compatible with what the CLI's
// `gatherStatus()` returns (plus the `runtimeMode` the CLI prepends), so the
// remote path prints identically to the local direct-PG path. Mirrored facts
// (kept in lockstep with the CLI, which is the source of truth):
//   - AUTH_TABLES list (probed in `public` via pg_tables)
//   - MCP settings live at metadata key `connector_config:mcp_server`
//   - userCount = 0 when the `user` table is absent; jwksKeyCount = null when
//     the `jwks` table is absent (vs 0 = present-but-empty)
// ---------------------------------------------------------------------------

import { betterAuthPool } from "@/lib/better-auth-db";
import { readMetadataValueFromDatabase } from "@/lib/database";

// Kept in lockstep with the published @cinatra-ai/cinatra CLI's `AUTH_TABLES`.
// The CLI is the source of truth; this server mirror is asserted equal by the
// CLI's status snapshot test against the documented shape.
const AUTH_TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "organization",
  "member",
  "invitation",
  "jwks",
  "oauthClient",
  "oauthAccessToken",
  "oauthRefreshToken",
  "oauthConsent",
  "team",
  "teamMember",
] as const;

// The CLI reads MCP settings from the schema `metadata` table at this exact
// key. `readMetadataValueFromDatabase` reads the SAME store.
const MCP_SETTINGS_KEY = "connector_config:mcp_server";

export type CliStatusPayload = {
  runtimeMode: string;
  authTablesPresent: string[];
  authTablesMissing: string[];
  userCount: number;
  mcpPublicBaseUrl: string | null;
  selfMcpClientId: string | null;
  jwksHealth: "absent" | "no-keys" | "present";
  jwksKeyCount: number | null;
};

/**
 * Gather the same status snapshot the CLI prints, reading the running
 * instance's own database through the shared server pool. Read-only.
 */
export async function gatherCliStatus(): Promise<CliStatusPayload> {
  const runtimeMode = process.env.CINATRA_RUNTIME_MODE?.trim() || "development";

  const authTableState = await readAuthTableState();
  const userCount = authTableState.present.includes("user")
    ? await readUserCount()
    : 0;
  const jwksRowCount = authTableState.present.includes("jwks")
    ? await readJwksRowCount()
    : null;

  const mcpSettings = readMetadataValueFromDatabase<{
    publicBaseUrl?: string | null;
    selfClient?: { clientId?: string | null } | null;
  }>(MCP_SETTINGS_KEY, {});

  const jwksHealth: CliStatusPayload["jwksHealth"] =
    jwksRowCount === null ? "absent" : jwksRowCount === 0 ? "no-keys" : "present";

  return {
    runtimeMode,
    authTablesPresent: authTableState.present,
    authTablesMissing: authTableState.missing,
    userCount,
    mcpPublicBaseUrl: mcpSettings?.publicBaseUrl ?? null,
    selfMcpClientId: mcpSettings?.selfClient?.clientId ?? null,
    jwksHealth,
    jwksKeyCount: jwksRowCount,
  };
}

async function readAuthTableState(): Promise<{
  present: string[];
  missing: string[];
}> {
  const { rows } = await betterAuthPool.query<{ tablename: string }>(
    `select tablename from pg_tables
     where schemaname = 'public' and tablename = any($1::text[])`,
    [AUTH_TABLES as unknown as string[]],
  );
  const present = new Set(rows.map((r) => String(r.tablename)));
  return {
    present: AUTH_TABLES.filter((t) => present.has(t)),
    missing: AUTH_TABLES.filter((t) => !present.has(t)),
  };
}

async function readUserCount(): Promise<number> {
  const { rows } = await betterAuthPool.query<{ count: string }>(
    `select count(*)::text as count from public."user"`,
  );
  return Number(rows[0]?.count ?? "0");
}

async function readJwksRowCount(): Promise<number> {
  const { rows } = await betterAuthPool.query<{ count: string }>(
    `select count(*)::text as count from public."jwks"`,
  );
  return Number(rows[0]?.count ?? "0");
}
