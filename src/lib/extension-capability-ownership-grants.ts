// Admin-approved, least-privilege CAPABILITY-OWNERSHIP grants for runtime
// extensions (the capability-ownership grant epic — S0 of the cinatra#975 widget-auth store inversion follow-up).
//
// WHAT THIS AUTHORIZES. Some host capabilities are CREDENTIAL-STORE owners: the
// package that "owns" a widget-auth token store (`connector_config:<token key>`)
// may mint/read the credentials the unauthenticated server-to-server surfaces
// (`/api/connect/token`, `/api/webhooks/wordpress`) rely on. Deciding WHICH
// runtime-installed package owns a given token store is privileged: a package
// self-DECLARING `cinatra.widgetStream.auth.tokenConfigKey` in its manifest MUST
// NOT, by that declaration alone, become the trusted owner (namespace squatting /
// fail-closed ambiguity). Ownership is an ADMIN-APPROVED grant here — modeled
// exactly on the live `extension-host-port-grants` primitive (per-`(package, org)`
// scope, admin `approved_by`, host-persisted, fail-closed) — so "self-declaration
// cannot create authority". No net-new cryptography: this extends the same
// admin-approval trust axis the host already uses to authorize privileged host
// capabilities (ports / host DDL).
//
// AUTO-APPROVE MIRRORS THE CAPABILITY SPLIT. The install pipeline records a
// `pending` ownership grant when a materialized manifest declares a widget-auth
// token key, and AUTO-APPROVES it ONLY for a `trusted-signed` package (the exact
// `autoGrantPrivileged = verdict.tier === "trusted-signed"` bar the pipeline
// already applies to ports / host DDL). Everything else (incl. `trusted-bootstrap`)
// stays `pending` for an admin. A credential-store owner can therefore never be a
// bootstrap/untrusted package.
//
// ANTI-SQUATTING IS A WRITE-TIME IMPOSSIBILITY. Two APPROVED owners for the same
// (token key, org) is forbidden by a DB partial UNIQUE index (see
// `drizzle-store.ts`: `..._approved_token_uniq` for org-scoped rows +
// `..._approved_token_global_uniq` for the `org_id IS NULL` global scope — a plain
// partial index does NOT constrain NULL org_id because SQL NULLs are distinct, so
// the global scope needs its own index). So even a `trusted-signed` third party that
// self-declares another connector's token key cannot become a SECOND approved owner.
//
// ALL READS FAIL CLOSED. `resolveOwnershipOwner` returns a package name ONLY for a
// row whose status is `approved`; any other status (or no row, or a lookup error at
// the caller) yields null → the consumer (widget-auth owner resolver (S1)) fails closed.
import "server-only";

import { createHash } from "node:crypto";

import {
  capturePriorWidgetStreamMetadataGrants,
  makeWidgetStreamMetadataGrantInstallDeps,
  recordWidgetStreamMetadataGrants,
  unwindWidgetStreamMetadataGrants,
  type CapturedWidgetStreamMetadataGrant,
  type WidgetStreamMetadataGrantClaim,
  type WidgetStreamMetadataGrantInstallHooks,
} from "@/lib/extension-widget-stream-metadata-grants";

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

/** Minimal async query surface (injected → unit-testable without a DB). */
export type OwnershipGrantQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

export type OwnershipGrantDeps = {
  query: OwnershipGrantQuery;
  /** The host schema the grants live in (default `cinatra`). */
  schema?: string;
};

// ---------------------------------------------------------------------------
// Lazy default DB query path (globalThis-cached pool — never a top-level pool,
// to keep `next build` page-data collection from throwing without a DB URL).
// Mirrors `extension-host-port-grants`.
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __cinatraOwnershipGrantPool: import("pg").Pool | undefined;
}

let ownershipGrantPoolInstance: import("pg").Pool | undefined;
async function getOwnershipGrantPool(): Promise<import("pg").Pool> {
  if (ownershipGrantPoolInstance) return ownershipGrantPoolInstance;
  if (globalThis.__cinatraOwnershipGrantPool) {
    return (ownershipGrantPoolInstance = globalThis.__cinatraOwnershipGrantPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @/lib/extension-capability-ownership-grants");
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[extension-capability-ownership-grants] pg pool idle client error:", err.message);
    });
  }
  ownershipGrantPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraOwnershipGrantPool = pool;
  }
  return pool;
}

async function defaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = await getOwnershipGrantPool();
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

async function resolveDeps(deps?: OwnershipGrantDeps): Promise<{
  query: OwnershipGrantQuery;
  schema: string;
}> {
  return {
    query: deps?.query ?? defaultQuery,
    schema: deps?.schema ?? schemaName,
  };
}

function qualifiedTable(schema: string): string {
  return `"${schema.replaceAll('"', '""')}"."extension_capability_ownership_grant"`;
}

// ---------------------------------------------------------------------------
// Manifest binding hash
// ---------------------------------------------------------------------------

/**
 * Stable sha256 over the normalized manifest ownership claim. A manifest change
 * that alters what the package claims to own MUST change this hash (so a stored
 * grant resets to `pending` and an admin must re-approve). Today the claim is the
 * declared token key alone; the hash is over a sorted, versioned object so the
 * bound tuple can grow without silently keeping a stale approval.
 */
export function computeManifestBindingHash(tokenConfigKey: string): string {
  const claim = { v: 1, tokenConfigKey: String(tokenConfigKey) };
  return createHash("sha256").update(JSON.stringify(claim)).digest("hex");
}

/**
 * Read the widget-auth token keys a materialized package's manifest DECLARES
 * (`cinatra.widgetStream[.auth].tokenConfigKey`), from its on-disk `package.json`
 * in the integrity-verified materialized store dir. `cinatra.widgetStream` may be
 * a single declaration object or an array of them. Absent / malformed → []. This
 * is the exact declaration the ownership grant binds; the install pipeline records
 * one `pending` grant per key returned.
 */
export async function readWidgetAuthTokenKeysFromStore(storeDir: string): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  let raw: string;
  try {
    raw = await readFile(path.join(storeDir, "package.json"), "utf8");
  } catch {
    return [];
  }
  let manifest: { cinatra?: { widgetStream?: unknown } };
  try {
    manifest = JSON.parse(raw) as typeof manifest;
  } catch {
    return [];
  }
  const declared = manifest.cinatra?.widgetStream;
  const entries = Array.isArray(declared) ? declared : declared != null ? [declared] : [];
  const keys = new Set<string>();
  for (const entry of entries) {
    const auth = (entry as { auth?: { tokenConfigKey?: unknown } } | null)?.auth;
    const key = auth?.tokenConfigKey;
    if (typeof key === "string" && key.trim()) keys.add(key.trim());
  }
  return Array.from(keys).sort();
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

type OwnershipRow = {
  id: string;
  package_name: string;
  org_id: string | null;
  token_config_key: string;
  manifest_binding_hash: string;
  status: string;
  approved_by: string | null;
};

export type CapabilityOwnershipGrant = {
  id: string;
  packageName: string;
  orgId: string | null;
  tokenConfigKey: string;
  manifestBindingHash: string;
  status: "pending" | "approved" | "revoked";
  approvedBy: string | null;
};

function rowToGrant(row: OwnershipRow): CapabilityOwnershipGrant {
  return {
    id: row.id,
    packageName: row.package_name,
    orgId: row.org_id,
    tokenConfigKey: row.token_config_key,
    manifestBindingHash: row.manifest_binding_hash,
    status: row.status as CapabilityOwnershipGrant["status"],
    approvedBy: row.approved_by,
  };
}

const SELECT_COLUMNS =
  "id, package_name, org_id, token_config_key, manifest_binding_hash, status, approved_by";

function orgClause(orgId: string | null, valueIndex: number): { clause: string; value: string | null } {
  return orgId === null
    ? { clause: "org_id IS NULL", value: null }
    : { clause: `org_id = $${valueIndex}`, value: orgId };
}

async function readGrantRow(
  query: OwnershipGrantQuery,
  schema: string,
  packageName: string,
  orgId: string | null,
  tokenConfigKey: string,
): Promise<CapabilityOwnershipGrant | null> {
  const table = qualifiedTable(schema);
  if (orgId === null) {
    const rows = await query<OwnershipRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${table}
        WHERE package_name = $1 AND token_config_key = $2 AND org_id IS NULL LIMIT 1`,
      [packageName, tokenConfigKey],
    );
    return rows[0] ? rowToGrant(rows[0]) : null;
  }
  const rows = await query<OwnershipRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${table}
      WHERE package_name = $1 AND token_config_key = $2 AND org_id = $3 LIMIT 1`,
    [packageName, tokenConfigKey, orgId],
  );
  return rows[0] ? rowToGrant(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type RecordRequestedOwnershipInput = {
  packageName: string;
  orgId: string | null;
  tokenConfigKey: string;
};

/**
 * Upsert a `pending` ownership grant row carrying the current manifest binding
 * hash.
 *
 * - No existing row → insert `pending` with the new hash.
 * - Existing row, SAME hash → leave untouched (preserve an existing approval).
 * - Existing row, DIFFERENT hash → reset to `pending`, clear approved_by, store
 *   the new hash (re-approval required after a manifest claim change).
 */
export async function recordRequestedOwnershipGrant(
  input: RecordRequestedOwnershipInput,
  deps?: OwnershipGrantDeps,
): Promise<CapabilityOwnershipGrant> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const hash = computeManifestBindingHash(input.tokenConfigKey);
  const existing = await readGrantRow(query, schema, input.packageName, input.orgId, input.tokenConfigKey);

  if (existing && existing.manifestBindingHash === hash) {
    return existing;
  }

  if (existing) {
    const { clause, value } = orgClause(input.orgId, 4);
    const values: unknown[] = [hash, input.packageName, input.tokenConfigKey];
    if (value !== null) values.push(value);
    const rows = await query<OwnershipRow>(
      `UPDATE ${table}
         SET manifest_binding_hash = $1,
             status = 'pending',
             approved_by = NULL,
             updated_at = now()
       WHERE package_name = $2 AND token_config_key = $3 AND ${clause}
       RETURNING ${SELECT_COLUMNS}`,
      values,
    );
    if (!rows[0]) throw new Error("extension_capability_ownership_grant update returned no row");
    return rowToGrant(rows[0]);
  }

  const rows = await query<OwnershipRow>(
    `INSERT INTO ${table} (package_name, org_id, token_config_key, manifest_binding_hash, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING ${SELECT_COLUMNS}`,
    [input.packageName, input.orgId, input.tokenConfigKey, hash],
  );
  if (!rows[0]) throw new Error("extension_capability_ownership_grant insert returned no row");
  return rowToGrant(rows[0]);
}

export type ApproveOwnershipInput = {
  packageName: string;
  orgId: string | null;
  tokenConfigKey: string;
  approvedBy: string;
  /**
   * The token key the manifest currently declares — verified to hash to the
   * row's stored `manifest_binding_hash`, so an approval can never be made
   * against a stale/absent request (the request was reset to `pending` on a
   * manifest change, and re-approval must be against the CURRENT claim).
   */
  tokenConfigKeyBasis?: string;
};

/**
 * Approve an ownership grant (admin, or the `trusted-signed` auto-approve path).
 * Requires an existing requested row. A SECOND approved owner for the same
 * (token key, org) is a DB write-time impossibility (the `..._approved_token_uniq`
 * / `..._approved_token_global_uniq` partial unique indexes) — a squatting
 * approval surfaces as a unique-violation error, never a silent second owner.
 */
export async function approveOwnershipGrant(
  input: ApproveOwnershipInput,
  deps?: OwnershipGrantDeps,
): Promise<CapabilityOwnershipGrant> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const existing = await readGrantRow(query, schema, input.packageName, input.orgId, input.tokenConfigKey);
  if (!existing) {
    throw new Error(
      `No requested capability-ownership grant for ${input.packageName} ` +
        `(token=${input.tokenConfigKey}, org=${input.orgId ?? "global"}); record a request first`,
    );
  }

  // Anti-stale: the basis must hash to the stored binding hash so an approval
  // cannot race a manifest (token-key) change. When omitted, the row's own token
  // key is the basis (an admin approving the recorded row as-is).
  const basisKey = input.tokenConfigKeyBasis ?? existing.tokenConfigKey;
  if (computeManifestBindingHash(basisKey) !== existing.manifestBindingHash) {
    throw new Error(
      `Manifest ownership claim for ${input.packageName} has changed since the request was recorded; ` +
        `re-record the request before approving`,
    );
  }

  // orgClause value is bound at $4 (after approvedBy $1, packageName $2, tokenConfigKey $3).
  const { clause, value } = orgClause(input.orgId, 4);
  const values: unknown[] = [input.approvedBy, input.packageName, input.tokenConfigKey];
  if (value !== null) values.push(value);
  const rows = await query<OwnershipRow>(
    `UPDATE ${table}
       SET status = 'approved',
           approved_by = $1,
           updated_at = now()
     WHERE package_name = $2 AND token_config_key = $3 AND ${clause}
     RETURNING ${SELECT_COLUMNS}`,
    values,
  );
  if (!rows[0]) throw new Error("extension_capability_ownership_grant approve returned no row");
  return rowToGrant(rows[0]);
}

export type RevokeOwnershipInput = {
  packageName: string;
  orgId: string | null;
  tokenConfigKey: string;
};

/** Revoke an ownership grant: status `revoked` (frees the approved-owner slot). */
export async function revokeOwnershipGrant(
  input: RevokeOwnershipInput,
  deps?: OwnershipGrantDeps,
): Promise<CapabilityOwnershipGrant | null> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const { clause, value } = orgClause(input.orgId, 3);
  const values: unknown[] = [input.packageName, input.tokenConfigKey];
  if (value !== null) values.push(value);
  const rows = await query<OwnershipRow>(
    `UPDATE ${table}
       SET status = 'revoked',
           approved_by = NULL,
           updated_at = now()
     WHERE package_name = $1 AND token_config_key = $2 AND ${clause}
     RETURNING ${SELECT_COLUMNS}`,
    values,
  );
  return rows[0] ? rowToGrant(rows[0]) : null;
}

export type ResolveOwnershipInput = {
  tokenConfigKey: string;
  orgId: string | null;
};

/**
 * Resolve the UNIQUE `approved` owner package for a token key, fail-closed.
 *
 * An org-specific approved owner takes precedence over a global (org_id IS NULL)
 * approved owner. Returns null when no approved owner exists at the resolved
 * scope. The `..._approved_token_uniq` / `..._approved_token_global_uniq` indexes
 * guarantee AT MOST ONE approved owner per (token key, scope), so this is either
 * exactly one package or none — never ambiguous. Any lookup error propagates so
 * the caller (S1 resolver) can fail closed; this function never returns a
 * package name it is not certain is the sole approved owner.
 *
 * NOTE: this is the runtime AUTHORITY axis the widget-auth owner resolver (S1) host slice will
 * union with the build-time generated-tree declarers (registered-provider +
 * trusted-signed classification are checked by S1 at the resolver, not here).
 */
export async function resolveOwnershipOwner(
  input: ResolveOwnershipInput,
  deps?: OwnershipGrantDeps,
): Promise<string | null> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  if (input.orgId !== null) {
    const orgRows = await query<Pick<OwnershipRow, "package_name">>(
      `SELECT package_name FROM ${table}
        WHERE token_config_key = $1 AND org_id = $2 AND status = 'approved' LIMIT 2`,
      [input.tokenConfigKey, input.orgId],
    );
    if (orgRows.length === 1) return orgRows[0]!.package_name;
    if (orgRows.length > 1) return null; // defensive: index makes this impossible
    // fall through to global scope
  }
  const globalRows = await query<Pick<OwnershipRow, "package_name">>(
    `SELECT package_name FROM ${table}
      WHERE token_config_key = $1 AND org_id IS NULL AND status = 'approved' LIMIT 2`,
    [input.tokenConfigKey],
  );
  if (globalRows.length === 1) return globalRows[0]!.package_name;
  return null; // 0 approved (fail closed) or >1 (defensive)
}

export type ReadOwnershipGrantInput = {
  packageName: string;
  orgId: string | null;
  tokenConfigKey: string;
};

/** Read the exact-scope ownership grant row (no global fallback) — for the
 * install pipeline's prior-state capture + the admin surface. */
export async function readOwnershipGrant(
  input: ReadOwnershipGrantInput,
  deps?: OwnershipGrantDeps,
): Promise<CapabilityOwnershipGrant | null> {
  const { query, schema } = await resolveDeps(deps);
  return readGrantRow(query, schema, input.packageName, input.orgId, input.tokenConfigKey);
}

export type RestoreOwnershipInput = {
  packageName: string;
  orgId: string | null;
  tokenConfigKey: string;
  status: "pending" | "approved" | "revoked";
  manifestBindingHash: string;
  approvedBy: string | null;
};

/**
 * DIRECTLY restore an ownership grant row to a previously-captured, already-valid
 * state (durable rollback). Unlike `recordRequestedOwnershipGrant` +
 * `approveOwnershipGrant` (which re-derive the binding hash + run the anti-stale
 * check), this re-writes the EXACT prior row state — the state being restored was
 * VALID when captured (it was the live grant of the previous, working install).
 * Used ONLY on the post-commit hot-update rollback path to re-pin the OLD
 * install's ownership grant; never on the forward install path (which must go
 * through the request→approve gates).
 */
export async function restoreOwnershipGrant(
  input: RestoreOwnershipInput,
  deps?: OwnershipGrantDeps,
): Promise<CapabilityOwnershipGrant> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const existing = await readGrantRow(query, schema, input.packageName, input.orgId, input.tokenConfigKey);
  if (existing) {
    // orgClause value is bound at $6 (after status $1, hash $2, approvedBy $3,
    // packageName $4, tokenConfigKey $5).
    const { clause, value } = orgClause(input.orgId, 6);
    const values: unknown[] = [
      input.status,
      input.manifestBindingHash,
      input.approvedBy,
      input.packageName,
      input.tokenConfigKey,
    ];
    if (value !== null) values.push(value);
    const rows = await query<OwnershipRow>(
      `UPDATE ${table}
         SET status = $1,
             manifest_binding_hash = $2,
             approved_by = $3,
             updated_at = now()
       WHERE package_name = $4 AND token_config_key = $5 AND ${clause}
       RETURNING ${SELECT_COLUMNS}`,
      values,
    );
    if (!rows[0]) throw new Error("extension_capability_ownership_grant restore update returned no row");
    return rowToGrant(rows[0]);
  }
  const rows = await query<OwnershipRow>(
    `INSERT INTO ${table} (package_name, org_id, token_config_key, manifest_binding_hash, status, approved_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SELECT_COLUMNS}`,
    [input.packageName, input.orgId, input.tokenConfigKey, input.manifestBindingHash, input.status, input.approvedBy],
  );
  if (!rows[0]) throw new Error("extension_capability_ownership_grant restore insert returned no row");
  return rowToGrant(rows[0]);
}

// ---------------------------------------------------------------------------
// Install-pipeline integration (extracted here so `extension-install-pipeline.ts`
// — a baselined file-size-ratchet bottleneck — gains no logic and no more than a
// couple of thin call-site lines; the pipeline reaches exactly ONE new module,
// this one, whether via the static step-helper imports or the deps-factory).
// These orchestrate the SAME record→auto-approve→durable-unwind lifecycle the
// host-port grant applies, over the capability-ownership axis. All accept the
// pipeline's optional install hooks (a pure no-op when the hooks are unwired, as
// in the older install-pipeline unit tests) so behavior is identical to the
// prior inline pipeline integration.
// ---------------------------------------------------------------------------

/** The install-pipeline hooks for the capability-ownership grant lifecycle
 * (widget-auth token-key ownership). Mirrors the host-port grant hooks. All
 * optional so existing pipeline unit tests can omit them (then no ownership
 * grant is recorded — a pure no-op leaving the resolver's runtime authority axis
 * empty); `makeOwnershipGrantInstallDeps()` wires all six — PLUS the sibling
 * widget-stream METADATA grant hooks (same lifecycle seam, distinct axis; see
 * `extension-widget-stream-metadata-grants.ts`), carried in this one type so
 * the install pipeline reaches only this module. */
export type OwnershipGrantInstallHooks = WidgetStreamMetadataGrantInstallHooks & {
  /** Read the widget-auth token keys the materialized (SRI-verified) manifest
   * DECLARES (`cinatra.widgetStream[.auth].tokenConfigKey`). */
  readWidgetAuthTokenKeys?: (storeDir: string) => Promise<string[]>;
  recordRequestedOwnershipGrant?: (input: {
    packageName: string;
    orgId: string | null;
    tokenConfigKey: string;
  }) => Promise<void>;
  approveOwnershipGrant?: (input: {
    packageName: string;
    orgId: string | null;
    tokenConfigKey: string;
    approvedBy: string;
  }) => Promise<void>;
  /** Revoke a just-recorded ownership grant on the FRESH-install rollback path
   * (no prior row to restore) so a failed, unfinalized install never leaves an
   * approved credential-store owner behind. */
  revokeOwnershipGrant?: (input: {
    packageName: string;
    orgId: string | null;
    tokenConfigKey: string;
  }) => Promise<void>;
  /** Read the exact-scope ownership grant row (no global fallback) — prior-state
   * capture for durable rollback. */
  readOwnershipGrant?: (
    packageName: string,
    orgId: string | null,
    tokenConfigKey: string,
  ) => Promise<{
    status: "pending" | "approved" | "revoked";
    manifestBindingHash: string;
    approvedBy: string | null;
  } | null>;
  /** Durable rollback: re-write the OLD ownership grant row to its captured state. */
  restoreOwnershipGrant?: (input: {
    packageName: string;
    orgId: string | null;
    tokenConfigKey: string;
    status: "pending" | "approved" | "revoked";
    manifestBindingHash: string;
    approvedBy: string | null;
  }) => Promise<void>;
};

export type CapturedOwnershipGrant = {
  tokenConfigKey: string;
  status: "pending" | "approved" | "revoked";
  manifestBindingHash: string;
  approvedBy: string | null;
};

/** The combined prior-state capture the pipeline threads from capture to
 * unwind: the ownership rows (per declared token key) AND the widget-stream
 * metadata rows (per claimed agent slug). */
export type CapturedPriorCapabilityGrants = {
  ownership: CapturedOwnershipGrant[];
  widgetMetadata: CapturedWidgetStreamMetadataGrant[];
};

/**
 * Capture the prior capability grants — ownership rows (one per token key the
 * manifest declares) AND widget-stream metadata rows (one per claimed slug) —
 * for durable rollback: the record steps may reset a prior approval against
 * the new claim before a later throw, so a failed update must re-pin the OLD
 * install's grant state on the unwind paths. Empty on a fresh install or when
 * the readers are unwired.
 */
export async function capturePriorOwnershipGrants(
  deps: Pick<OwnershipGrantInstallHooks, "readOwnershipGrant" | "readWidgetStreamMetadataGrant">,
  args: {
    isUpdate: boolean;
    packageName: string;
    orgId: string | null;
    declaredTokenKeys: readonly string[];
    widgetMetadataClaims?: readonly WidgetStreamMetadataGrantClaim[];
  },
): Promise<CapturedPriorCapabilityGrants> {
  const widgetMetadata = await capturePriorWidgetStreamMetadataGrants(deps, {
    isUpdate: args.isUpdate,
    packageName: args.packageName,
    orgId: args.orgId,
    claims: args.widgetMetadataClaims ?? [],
  });
  if (!args.isUpdate || !deps.readOwnershipGrant) return { ownership: [], widgetMetadata };
  const read = deps.readOwnershipGrant;
  const captured = await Promise.all(
    args.declaredTokenKeys.map(async (tokenConfigKey) => {
      const g = await read(args.packageName, args.orgId, tokenConfigKey);
      return g ? { tokenConfigKey, ...g } : null;
    }),
  );
  return {
    ownership: captured.filter((g): g is CapturedOwnershipGrant => g !== null),
    widgetMetadata,
  };
}

/**
 * For each widget-auth token key the manifest declares, record a PENDING
 * ownership grant and AUTO-APPROVE it ONLY for a `trusted-signed` package (the
 * SAME `autoGrantPrivileged` capability split as ports / host DDL). A
 * bootstrap/untrusted install records the request but stays PENDING for an
 * admin, so a credential-store owner can never be a bootstrap/untrusted package.
 * Anti-squatting is enforced at the DB (partial unique index) — approving a
 * second package for a token key another package already owns fails with a
 * unique violation, aborting the install. A pure no-op when the recorder is
 * unwired.
 *
 * The sibling widget-stream METADATA grants (per claimed slug) are recorded
 * AFTER the ownership pass — the metadata axis is conjoined to the ownership
 * axis, so the record-time conjunction check needs the (possibly just
 * auto-approved) owner in place. `autoGrantPrivileged` deliberately does NOT
 * reach the metadata axis: a metadata grant is NEVER auto-approved for any
 * trust tier — it always pends for an explicit admin approval of the displayed
 * canon.
 */
export async function recordAndAutoApproveOwnershipGrants(
  deps: Pick<
    OwnershipGrantInstallHooks,
    "recordRequestedOwnershipGrant" | "approveOwnershipGrant" | "recordWidgetStreamMetadataGrant"
  >,
  args: {
    declaredTokenKeys: readonly string[];
    autoGrantPrivileged: boolean;
    packageName: string;
    orgId: string | null;
    approvedBy: string;
    widgetMetadataClaims?: readonly WidgetStreamMetadataGrantClaim[];
  },
): Promise<void> {
  if (deps.recordRequestedOwnershipGrant) {
    for (const tokenConfigKey of args.declaredTokenKeys) {
      await deps.recordRequestedOwnershipGrant({
        packageName: args.packageName,
        orgId: args.orgId,
        tokenConfigKey,
      });
      if (args.autoGrantPrivileged && deps.approveOwnershipGrant) {
        await deps.approveOwnershipGrant({
          packageName: args.packageName,
          orgId: args.orgId,
          tokenConfigKey,
          approvedBy: args.approvedBy,
        });
      }
    }
  }
  await recordWidgetStreamMetadataGrants(deps, {
    claims: args.widgetMetadataClaims ?? [],
    packageName: args.packageName,
    orgId: args.orgId,
  });
}

/**
 * Undo THIS install attempt's capability-grant writes on a rollback path —
 * BOTH axes. Ownership: for each token key the (new) manifest declared, if a
 * prior OLD row was captured (an update) re-pin its EXACT state; otherwise (a
 * fresh install, or a NEW key this attempt added) REVOKE the
 * just-recorded/auto-approved grant so a failed, unfinalized install never
 * leaves an approved credential-store owner behind (fail-closed). Widget
 * metadata: captured prior rows are re-pinned (revocation-sticky); a fresh
 * pending row this attempt inserted is DELETED (it was never authority — no
 * auto-approve exists on that axis — and revoking it would fabricate an
 * admin-meaning tombstone). Best-effort + isolated per key/slug: a failure is
 * reported via `onFailure` (the pipeline routes it to its structured
 * durable-restore-failure event / completeness tracking) and never masks the
 * original install error.
 */
export async function unwindOwnershipGrants(args: {
  deps: Pick<
    OwnershipGrantInstallHooks,
    | "restoreOwnershipGrant"
    | "revokeOwnershipGrant"
    | "restoreWidgetStreamMetadataGrant"
    | "deleteUnapprovedWidgetStreamMetadataGrant"
  >;
  packageName: string;
  orgId: string | null;
  declaredTokenKeys: readonly string[];
  widgetMetadataClaims?: readonly WidgetStreamMetadataGrantClaim[];
  priorOwnershipGrants: CapturedPriorCapabilityGrants;
  onFailure: (error: unknown) => void;
}): Promise<void> {
  const { deps, packageName, orgId, declaredTokenKeys, priorOwnershipGrants, onFailure } = args;
  await unwindWidgetStreamMetadataGrants({
    hooks: deps,
    packageName,
    orgId,
    claims: args.widgetMetadataClaims ?? [],
    priorGrants: priorOwnershipGrants.widgetMetadata,
    onFailure,
  });
  if (!deps.restoreOwnershipGrant && !deps.revokeOwnershipGrant) return;
  const priorByKey = new Map(priorOwnershipGrants.ownership.map((g) => [g.tokenConfigKey, g]));
  for (const tokenConfigKey of declaredTokenKeys) {
    const prior = priorByKey.get(tokenConfigKey);
    try {
      if (prior && deps.restoreOwnershipGrant) {
        await deps.restoreOwnershipGrant({
          packageName,
          orgId,
          tokenConfigKey,
          status: prior.status,
          manifestBindingHash: prior.manifestBindingHash,
          approvedBy: prior.approvedBy,
        });
      } else if (!prior && deps.revokeOwnershipGrant) {
        await deps.revokeOwnershipGrant({ packageName, orgId, tokenConfigKey });
      }
    } catch (e) {
      onFailure(e);
    }
  }
}

/**
 * The capability-grant lifecycle hooks for `makeDefaultInstallPipelineDeps` —
 * widget-auth token-key ownership (this module) PLUS the widget-stream
 * metadata grant lifecycle (the sibling module), mirroring the host-port grant
 * wiring. The metadata factory receives THIS module's `resolveOwnershipOwner`
 * as its conjunction resolver (the dependency direction stays acyclic: the
 * metadata module never imports this one).
 */
export function makeOwnershipGrantInstallDeps(): OwnershipGrantInstallHooks {
  return {
    ...makeWidgetStreamMetadataGrantInstallDeps({
      resolveCredentialStoreOwner: (tokenConfigKey, orgId) =>
        resolveOwnershipOwner({ tokenConfigKey, orgId }),
    }),
    readWidgetAuthTokenKeys: (storeDir) => readWidgetAuthTokenKeysFromStore(storeDir),
    recordRequestedOwnershipGrant: (g) =>
      recordRequestedOwnershipGrant({
        packageName: g.packageName,
        orgId: g.orgId,
        tokenConfigKey: g.tokenConfigKey,
      }).then(() => undefined),
    approveOwnershipGrant: (g) =>
      approveOwnershipGrant({
        packageName: g.packageName,
        orgId: g.orgId,
        tokenConfigKey: g.tokenConfigKey,
        approvedBy: g.approvedBy,
      }).then(() => undefined),
    revokeOwnershipGrant: (g) =>
      revokeOwnershipGrant({
        packageName: g.packageName,
        orgId: g.orgId,
        tokenConfigKey: g.tokenConfigKey,
      }).then(() => undefined),
    readOwnershipGrant: async (packageName, orgId, tokenConfigKey) => {
      const g = await readOwnershipGrant({ packageName, orgId, tokenConfigKey });
      return g
        ? { status: g.status, manifestBindingHash: g.manifestBindingHash, approvedBy: g.approvedBy }
        : null;
    },
    restoreOwnershipGrant: (i) =>
      restoreOwnershipGrant({
        packageName: i.packageName,
        orgId: i.orgId,
        tokenConfigKey: i.tokenConfigKey,
        status: i.status,
        manifestBindingHash: i.manifestBindingHash,
        approvedBy: i.approvedBy,
      }).then(() => undefined),
  };
}
