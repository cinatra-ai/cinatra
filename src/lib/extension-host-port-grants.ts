// Admin-approved, least-privilege host-port grants for runtime extensions.
//
// The runtime loader/host-context consumes the APPROVED port set from here —
// NOT the raw manifest's requestedHostPorts. A manifest change to the requested
// ports changes `requested_ports_hash`, which resets an existing grant back to
// `pending` so an admin must re-approve before the new ports take effect.
//
// All reads fail closed: approved_ports are returned ONLY for a row whose
// status is `approved`; any other status (or no row) yields [].
import "server-only";

import { createHash } from "node:crypto";

import type { HostPortName } from "@cinatra-ai/sdk-extensions";

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

/** Minimal async query surface (injected → unit-testable without a DB). */
export type HostPortGrantQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

export type HostPortGrantDeps = {
  query: HostPortGrantQuery;
  /** The host schema grants live in (default `cinatra`). */
  schema?: string;
};

// ---------------------------------------------------------------------------
// Lazy default DB query path (globalThis-cached pool — never a top-level pool,
// to keep `next build` page-data collection from throwing without a DB URL).
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __cinatraHostPortGrantPool: import("pg").Pool | undefined;
}

let hostPortGrantPoolInstance: import("pg").Pool | undefined;
async function getHostPortGrantPool(): Promise<import("pg").Pool> {
  if (hostPortGrantPoolInstance) return hostPortGrantPoolInstance;
  if (globalThis.__cinatraHostPortGrantPool) {
    return (hostPortGrantPoolInstance = globalThis.__cinatraHostPortGrantPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @/lib/extension-host-port-grants");
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[extension-host-port-grants] pg pool idle client error:", err.message);
    });
  }
  hostPortGrantPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraHostPortGrantPool = pool;
  }
  return pool;
}

async function defaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = await getHostPortGrantPool();
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

async function resolveDeps(deps?: HostPortGrantDeps): Promise<{
  query: HostPortGrantQuery;
  schema: string;
}> {
  return {
    query: deps?.query ?? defaultQuery,
    schema: deps?.schema ?? schemaName,
  };
}

function qualifiedTable(schema: string): string {
  return `"${schema.replaceAll('"', '""')}"."extension_host_port_grant"`;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Stable sha256 over the sorted, de-duplicated requested port list. A manifest
 * change to the requested ports MUST change this hash (so a stored grant resets
 * to `pending` and re-approval is required). Order- and duplicate-independent.
 */
export function computeRequestedPortsHash(ports: readonly string[]): string {
  const normalized = Array.from(new Set(ports.map((p) => String(p)))).sort();
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function normalizePorts(ports: readonly string[]): string[] {
  return Array.from(new Set(ports.map((p) => String(p)))).sort();
}

function readJsonbPorts(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((p) => String(p));
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((p) => String(p)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

type GrantRow = {
  id: string;
  package_name: string;
  org_id: string | null;
  approved_ports: unknown;
  requested_ports_hash: string;
  status: string;
  approved_by: string | null;
};

export type HostPortGrant = {
  id: string;
  packageName: string;
  orgId: string | null;
  approvedPorts: string[];
  requestedPortsHash: string;
  status: "pending" | "approved" | "revoked";
  approvedBy: string | null;
};

function rowToGrant(row: GrantRow): HostPortGrant {
  return {
    id: row.id,
    packageName: row.package_name,
    orgId: row.org_id,
    approvedPorts: readJsonbPorts(row.approved_ports),
    requestedPortsHash: row.requested_ports_hash,
    status: row.status as HostPortGrant["status"],
    approvedBy: row.approved_by,
  };
}

const SELECT_COLUMNS =
  "id, package_name, org_id, approved_ports, requested_ports_hash, status, approved_by";

function orgClause(orgId: string | null, valueIndex: number): { clause: string; value: string | null } {
  // org_id may be null (a global grant); use `IS NOT DISTINCT FROM` so a null
  // matches a null row and the UNIQUE(package_name, org_id) target is hit.
  return orgId === null
    ? { clause: "org_id IS NULL", value: null }
    : { clause: `org_id = $${valueIndex}`, value: orgId };
}

async function readGrantRow(
  query: HostPortGrantQuery,
  schema: string,
  packageName: string,
  orgId: string | null,
): Promise<HostPortGrant | null> {
  const table = qualifiedTable(schema);
  if (orgId === null) {
    const rows = await query<GrantRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${table} WHERE package_name = $1 AND org_id IS NULL LIMIT 1`,
      [packageName],
    );
    return rows[0] ? rowToGrant(rows[0]) : null;
  }
  const rows = await query<GrantRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${table} WHERE package_name = $1 AND org_id = $2 LIMIT 1`,
    [packageName, orgId],
  );
  return rows[0] ? rowToGrant(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type RecordRequestedGrantInput = {
  packageName: string;
  orgId: string | null;
  requestedPorts: readonly HostPortName[];
};

/**
 * Upsert a `pending` grant row carrying the current requested-ports hash.
 *
 * - No existing row → insert `pending` with the new hash (empty approved_ports).
 * - Existing row, SAME hash → leave untouched (preserve an existing approval).
 * - Existing row, DIFFERENT hash → reset to `pending`, clear approved_ports +
 *   approved_by, and store the new hash (re-approval required on a change).
 */
export async function recordRequestedGrant(
  input: RecordRequestedGrantInput,
  deps?: HostPortGrantDeps,
): Promise<HostPortGrant> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const hash = computeRequestedPortsHash(input.requestedPorts);
  const existing = await readGrantRow(query, schema, input.packageName, input.orgId);

  if (existing && existing.requestedPortsHash === hash) {
    return existing;
  }

  if (existing) {
    // Requested ports changed — reset to pending, clear any prior approval.
    const { clause, value } = orgClause(input.orgId, 3);
    const values: unknown[] = [hash, input.packageName];
    if (value !== null) values.push(value);
    const rows = await query<GrantRow>(
      `UPDATE ${table}
         SET requested_ports_hash = $1,
             status = 'pending',
             approved_ports = '[]'::jsonb,
             approved_by = NULL,
             updated_at = now()
       WHERE package_name = $2 AND ${clause}
       RETURNING ${SELECT_COLUMNS}`,
      values,
    );
    if (!rows[0]) throw new Error("extension_host_port_grant update returned no row");
    return rowToGrant(rows[0]);
  }

  const rows = await query<GrantRow>(
    `INSERT INTO ${table} (package_name, org_id, approved_ports, requested_ports_hash, status)
     VALUES ($1, $2, '[]'::jsonb, $3, 'pending')
     RETURNING ${SELECT_COLUMNS}`,
    [input.packageName, input.orgId, hash],
  );
  if (!rows[0]) throw new Error("extension_host_port_grant insert returned no row");
  return rowToGrant(rows[0]);
}

export type ApproveGrantInput = {
  packageName: string;
  orgId: string | null;
  approvedPorts: readonly HostPortName[];
  approvedBy: string;
  /**
   * The ports the manifest currently requests — the basis for the subset
   * check. Must hash to the row's stored `requested_ports_hash` (proving the
   * approval is against the current, un-changed request). The approval UI
   * holds this list (it is what the admin is shown). When omitted, the subset
   * basis the approved set must be a subset of. REQUIRED — it is verified to
   * hash to the row's stored requested_ports_hash, so an approval can never be
   * made against an absent or stale request (no self-subset bypass).
   */
  requestedPorts: readonly HostPortName[];
};

/**
 * Approve a grant. `approvedPorts` MUST be a subset of the most recently
 * requested ports for the row — approving a port that was never requested (a
 * superset) is rejected. The requested set is supplied via `requestedPorts`
 * and is verified to hash to the row's stored `requested_ports_hash`, so an
 * approval cannot be made against a stale request. Requires an existing
 * requested grant row.
 */
export async function approveGrant(
  input: ApproveGrantInput,
  deps?: HostPortGrantDeps,
): Promise<HostPortGrant> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const existing = await readGrantRow(query, schema, input.packageName, input.orgId);
  if (!existing) {
    throw new Error(
      `No requested host-port grant for ${input.packageName} (org=${input.orgId ?? "global"}); record a request first`,
    );
  }

  // Subset basis: the currently-requested ports (MANDATORY). Verify they match
  // the stored hash so an approval cannot race a manifest (requested-ports)
  // change, and so an empty/omitted request can't make any set a self-subset.
  const requested = normalizePorts(input.requestedPorts);
  const requestedHash = computeRequestedPortsHash(input.requestedPorts);
  if (requestedHash !== existing.requestedPortsHash) {
    throw new Error(
      `Requested host ports for ${input.packageName} have changed since the request was recorded; re-record the request before approving`,
    );
  }
  const approved = normalizePorts(input.approvedPorts);
  const requestedSet = new Set(requested);
  const superset = approved.filter((p) => !requestedSet.has(p));
  if (superset.length > 0) {
    throw new Error(
      `Cannot approve host ports not requested by ${input.packageName}: ${superset.join(", ")}`,
    );
  }

  const { clause, value } = orgClause(input.orgId, 4);
  const values: unknown[] = [JSON.stringify(approved), input.approvedBy, input.packageName];
  if (value !== null) values.push(value);
  const rows = await query<GrantRow>(
    `UPDATE ${table}
       SET status = 'approved',
           approved_ports = $1::jsonb,
           approved_by = $2,
           updated_at = now()
     WHERE package_name = $3 AND ${clause}
     RETURNING ${SELECT_COLUMNS}`,
    values,
  );
  if (!rows[0]) throw new Error("extension_host_port_grant approve returned no row");
  return rowToGrant(rows[0]);
}

export type RevokeGrantInput = {
  packageName: string;
  orgId: string | null;
};

/** Revoke a grant: status `revoked`, approved_ports cleared. */
export async function revokeGrant(
  input: RevokeGrantInput,
  deps?: HostPortGrantDeps,
): Promise<HostPortGrant | null> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const { clause, value } = orgClause(input.orgId, 2);
  const values: unknown[] = [input.packageName];
  if (value !== null) values.push(value);
  const rows = await query<GrantRow>(
    `UPDATE ${table}
       SET status = 'revoked',
           approved_ports = '[]'::jsonb,
           updated_at = now()
     WHERE package_name = $1 AND ${clause}
     RETURNING ${SELECT_COLUMNS}`,
    values,
  );
  return rows[0] ? rowToGrant(rows[0]) : null;
}

export type ReadApprovedPortsInput = {
  packageName: string;
  orgId: string | null;
};

/**
 * Resolve the EFFECTIVE approved host ports for a package, fail-closed.
 *
 * Returns approved_ports ONLY when the resolved row's status is `approved`;
 * any other status (pending/revoked) or no row yields []. An org-specific row
 * takes precedence over a global (org_id IS NULL) row.
 */
export async function readApprovedPorts(
  input: ReadApprovedPortsInput,
  deps?: HostPortGrantDeps,
): Promise<string[]> {
  const { query, schema } = await resolveDeps(deps);
  if (input.orgId !== null) {
    const orgRow = await readGrantRow(query, schema, input.packageName, input.orgId);
    if (orgRow) {
      return orgRow.status === "approved" ? orgRow.approvedPorts : [];
    }
  }
  const globalRow = await readGrantRow(query, schema, input.packageName, null);
  if (globalRow) {
    return globalRow.status === "approved" ? globalRow.approvedPorts : [];
  }
  return [];
}

/**
 * Resolve the effective grant row (org-specific first, else global) — exposes
 * the full record (status + approvedPorts) so callers can distinguish an
 * approved-with-zero-ports grant from a pending/absent one. Returns null when
 * neither an org nor a global row exists.
 */
export async function readGrant(
  input: ReadApprovedPortsInput,
  deps?: HostPortGrantDeps,
): Promise<HostPortGrant | null> {
  const { query, schema } = await resolveDeps(deps);
  if (input.orgId !== null) {
    const orgRow = await readGrantRow(query, schema, input.packageName, input.orgId);
    if (orgRow) return orgRow;
  }
  return readGrantRow(query, schema, input.packageName, null);
}

/**
 * Resolve the grant row at the EXACT (package, org) scope — NO global
 * (org_id IS NULL) fallback. This is the resolution `resolveInstallAnchor`
 * effectively uses for its port decision: the anchor reads `readGrant` (which
 * MAY return a global row) but then DISCARDS any grant whose scope does not
 * exactly match the install's org (`(grant.orgId ?? null) === (deps.orgId ??
 * null)`), so an org-scoped install never inherits a global grant's approved
 * ports. Callers that must predict what activation will actually grant (the
 * hot-UPDATE pre-finalize probe) read THIS — never `readApprovedPorts`/`readGrant`,
 * whose global fallback would leak a cross-scope grant the anchor would refuse.
 * Returns null when no row exists at that exact scope.
 */
export async function readGrantForScope(
  input: ReadApprovedPortsInput,
  deps?: HostPortGrantDeps,
): Promise<HostPortGrant | null> {
  const { query, schema } = await resolveDeps(deps);
  return readGrantRow(query, schema, input.packageName, input.orgId);
}

export type RestoreGrantInput = {
  packageName: string;
  orgId: string | null;
  status: "pending" | "approved" | "revoked";
  approvedPorts: readonly string[];
  requestedPortsHash: string;
  approvedBy: string | null;
};

/**
 * DIRECTLY restore a grant row to a previously-captured, already-valid state
 * (Design B DURABLE ROLLBACK). Unlike `recordRequestedGrant` + `approveGrant`
 * (which re-derive the requested-ports hash + run the subset/anti-stale checks),
 * this re-writes the EXACT prior row state — status, approved_ports,
 * requested_ports_hash, approved_by — because the state being restored was VALID
 * when it was captured (it was the live grant of the previous, working install).
 * Upserts the (package, org) row. Used ONLY on the post-commit rollback path to
 * re-pin the OLD install's grant after a failed hot-update; never on the forward
 * install path (which must go through the request→approve gates).
 */
export async function restoreGrant(
  input: RestoreGrantInput,
  deps?: HostPortGrantDeps,
): Promise<HostPortGrant> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const approved = JSON.stringify(normalizePorts(input.approvedPorts));
  const existing = await readGrantRow(query, schema, input.packageName, input.orgId);
  if (existing) {
    const { clause, value } = orgClause(input.orgId, 5);
    const values: unknown[] = [input.status, approved, input.requestedPortsHash, input.approvedBy, input.packageName];
    if (value !== null) values.push(value);
    const rows = await query<GrantRow>(
      `UPDATE ${table}
         SET status = $1,
             approved_ports = $2::jsonb,
             requested_ports_hash = $3,
             approved_by = $4,
             updated_at = now()
       WHERE package_name = $5 AND ${clause}
       RETURNING ${SELECT_COLUMNS}`,
      values,
    );
    if (!rows[0]) throw new Error("extension_host_port_grant restore update returned no row");
    return rowToGrant(rows[0]);
  }
  const rows = await query<GrantRow>(
    `INSERT INTO ${table} (package_name, org_id, approved_ports, requested_ports_hash, status, approved_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)
     RETURNING ${SELECT_COLUMNS}`,
    [input.packageName, input.orgId, approved, input.requestedPortsHash, input.status, input.approvedBy],
  );
  if (!rows[0]) throw new Error("extension_host_port_grant restore insert returned no row");
  return rowToGrant(rows[0]);
}
