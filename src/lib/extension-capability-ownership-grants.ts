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
 * widget-stream METADATA grant hooks (same lifecycle seam, distinct axis; the
 * metadata-grant section further down in THIS module), carried in this one
 * type so the install pipeline reaches only this module. */
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
 * install's grant state on the unwind paths. The ownership capture is
 * update-gated (a fresh install's unwind REVOKES its own writes); the metadata
 * capture is NOT — a metadata row outlives installs on its durable
 * `(package, slug)` identity, so even a "fresh" install may meet a
 * pre-existing row the unwind must restore rather than delete.
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
 * widget-auth token-key ownership PLUS the widget-stream metadata grant
 * lifecycle (the metadata-grant section below), mirroring the host-port grant
 * wiring. The metadata factory receives `resolveOwnershipOwner` as its
 * conjunction resolver explicitly (the metadata section never reaches back
 * into the ownership internals).
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

// ===========================================================================
// WIDGET-STREAM METADATA GRANTS (widget-stream runtime trust, slice 1)
//
// The sibling trust axis of the credential-store ownership grant above, kept
// IN THIS module (not a new file) so the locked routes' reachable first-party
// graph is unchanged — the exact precedent extension-grant-schema.ts records
// for the DDL leaves (no new node per extracted concern). Same mechanism
// shape, distinct capability discriminator: the AGENT SLUG.
//
// NO AUTO-APPROVE — EVER. Unlike ports / host DDL / credential-store
// ownership, the metadata grant is NEVER auto-approved, not even for a
// `trusted-signed` first install: every record lands `pending` and requires
// an explicit platform-admin approval (CAS on the exact displayed hash) of
// the strict canonical v2 binding over the FULL declared canon. Revocation is
// a durable, sticky tombstone (reinstalls never resurrect OR silently re-pend
// it; only the explicit admin reopen below reconsiders it). Recording is
// conjoined to the ownership axis (the package must BE the approved owner of
// the declared token store) and refuses build-slug collisions and dangerous
// values. All reads fail closed.
// ===========================================================================



/** Minimal async query surface (injected → unit-testable without a DB). */
export type WidgetStreamMetadataGrantQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

export type WidgetStreamMetadataGrantDeps = {
  query: WidgetStreamMetadataGrantQuery;
  /** The host schema the grants live in (default `cinatra`). */
  schema?: string;
};

// ---------------------------------------------------------------------------
// Lazy default DB query path (globalThis-cached pool — never a top-level pool,
// to keep `next build` page-data collection from throwing without a DB URL).
// Mirrors `extension-capability-ownership-grants`.
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __cinatraWidgetStreamMetadataGrantPool: import("pg").Pool | undefined;
}

let metadataGrantPoolInstance: import("pg").Pool | undefined;
async function getMetadataGrantPool(): Promise<import("pg").Pool> {
  if (metadataGrantPoolInstance) return metadataGrantPoolInstance;
  if (globalThis.__cinatraWidgetStreamMetadataGrantPool) {
    return (metadataGrantPoolInstance = globalThis.__cinatraWidgetStreamMetadataGrantPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for the widget-stream metadata grants (extension-capability-ownership-grants)");
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[widget-stream-metadata-grants] pg pool idle client error:", err.message);
    });
  }
  metadataGrantPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraWidgetStreamMetadataGrantPool = pool;
  }
  return pool;
}

async function wsmDefaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = await getMetadataGrantPool();
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

async function wsmResolveDeps(deps?: WidgetStreamMetadataGrantDeps): Promise<{
  query: WidgetStreamMetadataGrantQuery;
  schema: string;
}> {
  return {
    query: deps?.query ?? wsmDefaultQuery,
    schema: deps?.schema ?? schemaName,
  };
}

function wsmQualifiedTable(schema: string): string {
  return `"${schema.replaceAll('"', '""')}"."extension_widget_stream_metadata_grant"`;
}

// ---------------------------------------------------------------------------
// The v:2 canon — schema, bounds, and the dangerous-value constraints
// ---------------------------------------------------------------------------

export type WidgetStreamMetadataContextField = { key: string; maxLength: number };

/**
 * The EXACT tuple an admin approves. Every field can reach a security decision
 * or the widget UI, so every field is bound — a change to ANY of them changes
 * `bindingHashV2` and re-pends the grant. `relayAgentPackage` is `null` (bound
 * as null) for a widget that declares no relay. `auth.requireUserToken` is
 * pinned `true`: a runtime declaration may not opt out of the fail-closed
 * per-user-token check (flat prohibition in the pilot — an absent flag defaults
 * to the enforcing value; an explicit `false` refuses the whole declaration).
 */
export type WidgetStreamMetadataCanonV2 = {
  v: 2;
  agentSlug: string;
  packageName: string;
  /** The `package.json` `exports` key of the widget-chat-tool module (the
   * resolved target is re-checked at load time by the runtime loader slice). */
  moduleExportKey: string;
  factory: string;
  relayAgentPackage: string | null;
  skillCapability: string;
  contextFields: WidgetStreamMetadataContextField[];
  label: string;
  subjectNoun: string;
  auth: {
    tokenConfigKey: string;
    instancesConfigKey: string;
    requiredInstanceFields: string[];
    requireUserToken: true;
  };
};

/** A validated, canonicalized declaration ready to record: the canon, its
 * canonical JSON text (stored for admin display), and its binding hash (the
 * authoritative comparison value). */
export type WidgetStreamMetadataGrantClaim = {
  agentSlug: string;
  packageName: string;
  canon: WidgetStreamMetadataCanonV2;
  canonJson: string;
  bindingHashV2: string;
};

const WIDGET_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FACTORY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CONFIG_KEY_RE = /^[a-z0-9_]+$/;
const CONTEXT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const SCOPED_PACKAGE_RE = /^@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/;
/** A context field must never name credential/secret material — the fields are
 * forwarded CMS PAGE context, and a secret-shaped key is refused outright. The
 * key is NORMALIZED before matching (lowercased, separators stripped) so
 * `privateKey` / `private-key` / `private_key` all hit the same denylist entry
 * (codex round-1 finding: separator-sensitive matching was bypassable). */
const SECRETISH_CONTEXT_KEY_SUBSTRINGS = [
  "password", "passwd", "passphrase", "secret", "credential", "token",
  "apikey", "privatekey", "accesskey", "secretkey", "signingkey", "clientkey",
  "bearer", "session", "cookie", "authorization", "jwt", "oauth", "otp",
] as const;

function isSecretShapedContextKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return SECRETISH_CONTEXT_KEY_SUBSTRINGS.some((s) => normalized.includes(s));
}

const MAX_SLUG_LENGTH = 64;
const MAX_FACTORY_LENGTH = 128;
const MAX_CONFIG_KEY_LENGTH = 64;
const MAX_PACKAGE_NAME_LENGTH = 214; // npm's own limit
const MAX_MODULE_EXPORT_KEY_LENGTH = 128;
const MAX_LABEL_LENGTH = 120;
const MAX_SUBJECT_NOUN_LENGTH = 60;
const MAX_CONTEXT_FIELDS = 16;
const MAX_CONTEXT_KEY_LENGTH = 64;
const MAX_CONTEXT_FIELD_BOUND = 2000;
const MAX_REQUIRED_INSTANCE_FIELDS = 32;
const MAX_INSTANCE_FIELD_LENGTH = 64;

/**
 * First-party host/core package names a runtime widget canon may NEVER name as
 * its relay agent (`relayAgentPackage` steers which package the host pre-creates
 * the OBO-carrier agent_run for — pointing it at host infrastructure would be a
 * privilege lever). Record-time defense-in-depth: the AUTHORITATIVE gate is the
 * point-of-use re-assert (the relay target must classify as an active
 * `trusted-signed` EXTENSION — which no host workspace package ever does).
 * Snapshot of the host workspace package names (packages dir) + the app.
 */
const HOST_RESERVED_PACKAGES: ReadonlySet<string> = new Set([
  "cinatra",
  "@cinatra-ai/a2a",
  "@cinatra-ai/agent-ui-protocol",
  "@cinatra-ai/agents",
  "@cinatra-ai/artifacts",
  "@cinatra-ai/chat",
  "@cinatra-ai/cli",
  "@cinatra-ai/connectors",
  "@cinatra-ai/connectors-catalog",
  "@cinatra-ai/dashboards",
  "@cinatra-ai/design",
  "@cinatra-ai/errors",
  "@cinatra-ai/extension-types",
  "@cinatra-ai/extensions",
  "@cinatra-ai/google-oauth-connection",
  "@cinatra-ai/llm",
  "@cinatra-ai/marketplace-application-reconcile",
  // (the legacy vendored marketplace client is intentionally NOT named here —
  // the org bans new textual references to it; it is not an installable
  // extension, and the use-time trusted-signed re-assert denies it anyway)
  "@cinatra-ai/marketplace-mcp-contract",
  "@cinatra-ai/marketplace-sync",
  "@cinatra-ai/mcp-client",
  "@cinatra-ai/mcp-server",
  "@cinatra-ai/metric-contracts",
  "@cinatra-ai/metric-cost-api",
  "@cinatra-ai/metric-usage-api",
  "@cinatra-ai/migrations",
  "@cinatra-ai/notifications",
  "@cinatra-ai/objects",
  "@cinatra-ai/permissions",
  "@cinatra-ai/pm-schedule-reconcile",
  "@cinatra-ai/projects",
  "@cinatra-ai/registries",
  "@cinatra-ai/sdk-dashboard",
  "@cinatra-ai/sdk-extensions",
  "@cinatra-ai/sdk-ui",
  "@cinatra-ai/skills",
  "@cinatra-ai/streams",
  "@cinatra-ai/trigger",
  "@cinatra-ai/trigger-email-send",
  "@cinatra-ai/webhooks",
  "@cinatra-ai/workflows",
]);

function isNfc(s: string): boolean {
  return s === s.normalize("NFC");
}

/**
 * The package's OWN instances-config namespace, derived from its name (pilot
 * convention, matching every baked connector: `@scope/wordpress-mcp-connector`
 * → `wordpress`). A canon whose `instancesConfigKey` is not this exact value is
 * refused — a widget may never read another package's instances store.
 */
export function ownInstancesNamespace(packageName: string): string | null {
  const m = packageName.match(/^@[^/]+\/(.+)$/);
  if (!m) return null;
  return m[1]!.replace(/-mcp-connector$/, "").replace(/-connector$/, "").replaceAll("-", "_");
}

/** Validate a fully-built canon. Returns human-readable errors ([] = valid).
 * Strings must ALREADY be NFC (the claim builder normalizes; a non-NFC canon
 * is rejected so a hash is only ever computed over the normalized form). */
export function validateWidgetStreamMetadataCanon(canon: WidgetStreamMetadataCanonV2): string[] {
  const errors: string[] = [];
  const bounded = (value: string, max: number, at: string) => {
    if (!isNfc(value)) errors.push(`${at}: must be NFC-normalized`);
    if (value !== value.trim()) errors.push(`${at}: must not carry surrounding whitespace`);
    if (value.length === 0 || value.length > max) errors.push(`${at}: length must be 1..${max}`);
  };
  if (canon.v !== 2) errors.push("v: must be 2");
  bounded(canon.agentSlug, MAX_SLUG_LENGTH, "agentSlug");
  if (!WIDGET_SLUG_RE.test(canon.agentSlug)) errors.push("agentSlug: must be a kebab-case slug");
  bounded(canon.packageName, MAX_PACKAGE_NAME_LENGTH, "packageName");
  if (!SCOPED_PACKAGE_RE.test(canon.packageName)) errors.push("packageName: must be a scoped npm package name");
  bounded(canon.moduleExportKey, MAX_MODULE_EXPORT_KEY_LENGTH, "moduleExportKey");
  if (!isPlainContainedSubpath(canon.moduleExportKey)) {
    errors.push("moduleExportKey: must be a plain './'-relative subpath (no patterns, escapes, or traversal segments)");
  }
  bounded(canon.factory, MAX_FACTORY_LENGTH, "factory");
  if (!FACTORY_RE.test(canon.factory)) errors.push("factory: must be a JS identifier");
  if (canon.relayAgentPackage !== null) {
    bounded(canon.relayAgentPackage, MAX_PACKAGE_NAME_LENGTH, "relayAgentPackage");
    if (!SCOPED_PACKAGE_RE.test(canon.relayAgentPackage)) {
      errors.push("relayAgentPackage: must be a scoped npm package name");
    } else {
      const ownScope = canon.packageName.split("/")[0];
      const relayScope = canon.relayAgentPackage.split("/")[0];
      if (relayScope !== ownScope) {
        errors.push("relayAgentPackage: must be in the declaring package's own scope (no cross-vendor relay delegation)");
      }
      if (HOST_RESERVED_PACKAGES.has(canon.relayAgentPackage)) {
        errors.push("relayAgentPackage: host/core packages may not be named as a relay target");
      }
      if (canon.relayAgentPackage === canon.packageName) {
        errors.push("relayAgentPackage: must name the connector's companion agent package, not the connector itself");
      }
    }
  }
  bounded(canon.skillCapability, MAX_LABEL_LENGTH, "skillCapability");
  if (canon.skillCapability !== `widget-chat.${canon.agentSlug}`) {
    errors.push("skillCapability: must be the package's own `widget-chat.<agentSlug>` namespace");
  }
  if (!Array.isArray(canon.contextFields) || canon.contextFields.length === 0) {
    errors.push("contextFields: must be a non-empty array");
  } else if (canon.contextFields.length > MAX_CONTEXT_FIELDS) {
    errors.push(`contextFields: at most ${MAX_CONTEXT_FIELDS} fields`);
  } else {
    const seen = new Set<string>();
    canon.contextFields.forEach((f, i) => {
      bounded(f.key, MAX_CONTEXT_KEY_LENGTH, `contextFields[${i}].key`);
      if (!CONTEXT_KEY_RE.test(f.key)) errors.push(`contextFields[${i}].key: must be an identifier`);
      if (isSecretShapedContextKey(f.key)) {
        errors.push(`contextFields[${i}].key: must not name credential/secret material`);
      }
      if (seen.has(f.key)) errors.push(`contextFields[${i}].key: duplicate "${f.key}"`);
      seen.add(f.key);
      if (!Number.isInteger(f.maxLength) || f.maxLength <= 0 || f.maxLength > MAX_CONTEXT_FIELD_BOUND) {
        errors.push(`contextFields[${i}].maxLength: must be an integer in 1..${MAX_CONTEXT_FIELD_BOUND}`);
      }
      if (i > 0 && canon.contextFields[i - 1]!.key >= f.key) {
        errors.push("contextFields: must be sorted by key (canonical order)");
      }
    });
  }
  bounded(canon.label, MAX_LABEL_LENGTH, "label");
  bounded(canon.subjectNoun, MAX_SUBJECT_NOUN_LENGTH, "subjectNoun");
  for (const k of ["tokenConfigKey", "instancesConfigKey"] as const) {
    bounded(canon.auth[k], MAX_CONFIG_KEY_LENGTH, `auth.${k}`);
    if (!CONFIG_KEY_RE.test(canon.auth[k])) errors.push(`auth.${k}: must be a snake_case connector-config key`);
  }
  const ownNamespace = ownInstancesNamespace(canon.packageName);
  if (ownNamespace === null || canon.auth.instancesConfigKey !== ownNamespace) {
    errors.push(
      "auth.instancesConfigKey: must be the package's OWN instances namespace " +
        `("${ownNamespace ?? "?"}"), never another package's`,
    );
  }
  // ANCHOR the instances namespace to the ADMIN-APPROVED credential-store
  // ownership axis (codex round-1 finding: the package-name derivation alone is
  // non-injective — e.g. a cross-vendor `@evil/wordpress-connector` would
  // derive "wordpress"). Requiring tokenConfigKey === `<instancesConfigKey>_widget_auth`
  // means claiming an instances namespace requires OWNING that namespace's
  // widget-auth token store, and the sibling grant's anti-squat partial-unique
  // index makes that ownership exclusive. Matches every baked connector
  // (`wordpress_widget_auth`/`wordpress`, `drupal_widget_auth`/`drupal`).
  if (canon.auth.tokenConfigKey !== `${canon.auth.instancesConfigKey}_widget_auth`) {
    errors.push(
      "auth.tokenConfigKey: must be `<instancesConfigKey>_widget_auth` — the instances " +
        "namespace is anchored to the admin-approved credential-store ownership of that token store",
    );
  }
  if (!Array.isArray(canon.auth.requiredInstanceFields)) {
    errors.push("auth.requiredInstanceFields: must be an array");
  } else if (canon.auth.requiredInstanceFields.length > MAX_REQUIRED_INSTANCE_FIELDS) {
    errors.push(`auth.requiredInstanceFields: at most ${MAX_REQUIRED_INSTANCE_FIELDS} entries`);
  } else {
    canon.auth.requiredInstanceFields.forEach((f, i) => {
      bounded(f, MAX_INSTANCE_FIELD_LENGTH, `auth.requiredInstanceFields[${i}]`);
      if (i > 0 && canon.auth.requiredInstanceFields[i - 1]! >= f) {
        errors.push("auth.requiredInstanceFields: must be sorted (canonical order)");
      }
    });
  }
  if (canon.auth.requireUserToken !== true) {
    errors.push("auth.requireUserToken: must be exactly true (runtime opt-out is prohibited)");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Strict canonical JSON + the binding hash
// ---------------------------------------------------------------------------

/**
 * Deterministic canonical JSON: object keys sorted by UTF-16 code unit,
 * arrays in order, only JSON primitives admitted. Combined with the NFC
 * normalization + semantic sorts applied by the claim builder, one canon has
 * exactly ONE serialization — the hash input.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJsonStringify: non-finite number");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new Error(`canonicalJsonStringify: unsupported type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonStringify(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`).join(",")}}`;
}

/**
 * sha256 over the strict canonical JSON of a VALID v:2 canon. Throws on an
 * invalid canon — a hash is never computed over a claim the schema refused, so
 * an invalid claim can neither pend nor be approved.
 */
export function computeWidgetStreamBindingHashV2(canon: WidgetStreamMetadataCanonV2): string {
  const errors = validateWidgetStreamMetadataCanon(canon);
  if (errors.length > 0) {
    throw new Error(`computeWidgetStreamBindingHashV2: invalid canon:\n  - ${errors.join("\n  - ")}`);
  }
  return createHash("sha256").update(canonicalJsonStringify(canon)).digest("hex");
}

// ---------------------------------------------------------------------------
// Duplicate-key-rejecting JSON parse (differential-parsing defense: two
// parsers disagreeing on which duplicate wins must never disagree about what
// an admin approved — a manifest carrying ANY duplicate key is refused whole).
// ---------------------------------------------------------------------------

export function parseJsonRejectingDuplicateKeys(text: string): unknown {
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`parseJsonRejectingDuplicateKeys: ${msg} at offset ${i}`);
  };
  const skipWs = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const parseString = (): string => {
    if (text[i] !== '"') fail("expected string");
    const start = i;
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        const raw = text.slice(start, i + 1);
        i++;
        // Delegate escape/codepoint semantics to the native parser for the
        // single scalar (no duplicate-key hazard inside one string).
        return JSON.parse(raw) as string;
      }
      if (c === "\\") {
        i += 2;
        continue;
      }
      if ((c as string) < " ") fail("unescaped control character in string");
      i++;
    }
    return fail("unterminated string");
  };
  const parseValue = (): unknown => {
    skipWs();
    const c = text[i];
    if (c === '"') return parseString();
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      const keys = new Set<string>();
      skipWs();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        skipWs();
        const key = parseString();
        if (keys.has(key)) fail(`duplicate object key "${key}"`);
        // Fail-closed hardening (codex round-1 finding): a plain `obj[key] =`
        // assignment would make a "__proto__" key MUTATE the prototype
        // (differential vs JSON.parse + pollution). No legitimate manifest
        // carries the key, so refuse it outright; every other key is written
        // as an OWN data property, exactly like JSON.parse.
        if (key === "__proto__") fail('forbidden object key "__proto__"');
        keys.add(key);
        skipWs();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        Object.defineProperty(obj, key, {
          value: parseValue(),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        skipWs();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      skipWs();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue());
        skipWs();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail("expected ',' or ']'");
      }
    }
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    const numMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (numMatch) {
      i += numMatch[0].length;
      return Number(numMatch[0]);
    }
    return fail("unexpected token");
  };
  const value = parseValue();
  skipWs();
  if (i !== text.length) fail("trailing content");
  return value;
}

// ---------------------------------------------------------------------------
// Reading claims from the materialized store dir
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `moduleExportKey` must resolve, in the materialized `package.json`
 * `exports`, to a SINGLE plain string target — conditional objects, arrays,
 * patterns (`*` in key or target), and `null` are refused (the runtime loader
 * slice re-resolves the same key at load; an ambiguous mapping must never be
 * approvable).
 */
const EXPORT_TARGET_RE = /^\.\/[A-Za-z0-9._/-]+$/;

/** True when a "./"-relative subpath is a plain, contained path: charset-bound
 * (no `%` escapes, no backslashes, no `*` patterns — outside the class) and
 * free of empty/`.`/`..`/`node_modules` segments, mirroring Node's own
 * invalid-segment exports rules (codex round-1 finding: `..` alone was not
 * enough). The runtime loader slice re-asserts realpath containment at load. */
function isPlainContainedSubpath(subpath: string): boolean {
  if (!EXPORT_TARGET_RE.test(subpath)) return false;
  const segments = subpath.slice(2).split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== ".." && s !== "node_modules");
}

function resolveSingleStringExport(exportsField: unknown, key: string): string | null {
  if (!isObj(exportsField)) return null;
  if (!Object.prototype.hasOwnProperty.call(exportsField, key)) return null;
  const target = (exportsField as Record<string, unknown>)[key];
  if (typeof target !== "string") return null;
  if (!isPlainContainedSubpath(target)) return null;
  return target;
}

const DEFAULT_MODULE_EXPORT_KEY = "./widget-chat-tool";

type RawDeclarationResult =
  | { ok: true; claim: WidgetStreamMetadataGrantClaim }
  | { ok: false; error: string };

const DECLARATION_KEYS = new Set([
  "agentSlug", "label", "subjectNoun", "skillCapability", "relayAgentPackage",
  "factory", "moduleExportKey", "contextFields", "auth",
]);
const AUTH_KEYS = new Set(["tokenConfigKey", "instancesConfigKey", "requiredInstanceFields", "requireUserToken"]);
const CONTEXT_FIELD_KEYS = new Set(["key", "maxLength"]);

/** Strict schema: an unknown key anywhere in the declaration refuses it (codex
 * round-1 finding — a lenient schema invites semantics the canon never bound). */
function unknownKeyOf(obj: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) return k;
  return null;
}

function buildClaimFromDeclaration(
  packageName: string,
  raw: unknown,
  exportsField: unknown,
): RawDeclarationResult {
  if (!isObj(raw)) return { ok: false, error: "declaration must be an object" };
  const unknownKey = unknownKeyOf(raw, DECLARATION_KEYS);
  if (unknownKey !== null) return { ok: false, error: `unknown declaration key "${unknownKey}"` };
  // NFC-normalize ONLY — no trimming: surrounding whitespace is refused by the
  // canon validator, never silently rewritten (two byte-distinct declarations
  // must not converge onto one hash except through Unicode normalization).
  const nfc = (v: unknown): string | null => (typeof v === "string" ? v.normalize("NFC") : null);
  const agentSlug = nfc(raw.agentSlug);
  const label = nfc(raw.label);
  const subjectNoun = nfc(raw.subjectNoun);
  const skillCapability = nfc(raw.skillCapability);
  const factory = nfc(raw.factory);
  if (factory === null) {
    // Runtime claims must DECLARE the factory (a materialized package ships
    // built artifacts only — there is no source tree to scan, unlike the
    // build-time generator).
    return { ok: false, error: "factory: runtime declarations must name the widget-chat-tool factory export" };
  }
  const moduleExportKey =
    raw.moduleExportKey === undefined ? DEFAULT_MODULE_EXPORT_KEY : nfc(raw.moduleExportKey);
  if (moduleExportKey === null) return { ok: false, error: "moduleExportKey: must be a string when present" };
  let relayAgentPackage: string | null;
  if (raw.relayAgentPackage === undefined || raw.relayAgentPackage === null) {
    relayAgentPackage = null;
  } else {
    relayAgentPackage = nfc(raw.relayAgentPackage);
    if (relayAgentPackage === null) return { ok: false, error: "relayAgentPackage: must be a string when present" };
  }
  if (!Array.isArray(raw.contextFields)) return { ok: false, error: "contextFields: must be an array" };
  const contextFields: WidgetStreamMetadataContextField[] = [];
  for (const f of raw.contextFields) {
    if (!isObj(f)) return { ok: false, error: "contextFields: each entry must be an object" };
    const unknownFieldKey = unknownKeyOf(f, CONTEXT_FIELD_KEYS);
    if (unknownFieldKey !== null) return { ok: false, error: `contextFields: unknown key "${unknownFieldKey}"` };
    const key = nfc(f.key);
    if (key === null || typeof f.maxLength !== "number") {
      return { ok: false, error: "contextFields: each entry must be { key, maxLength }" };
    }
    contextFields.push({ key, maxLength: f.maxLength });
  }
  contextFields.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (!isObj(raw.auth)) return { ok: false, error: "auth: must be an object" };
  const unknownAuthKey = unknownKeyOf(raw.auth, AUTH_KEYS);
  if (unknownAuthKey !== null) return { ok: false, error: `auth: unknown key "${unknownAuthKey}"` };
  const tokenConfigKey = nfc(raw.auth.tokenConfigKey);
  const instancesConfigKey = nfc(raw.auth.instancesConfigKey);
  if (tokenConfigKey === null || instancesConfigKey === null) {
    return { ok: false, error: "auth: tokenConfigKey + instancesConfigKey must be strings" };
  }
  if (!Array.isArray(raw.auth.requiredInstanceFields)) {
    return { ok: false, error: "auth.requiredInstanceFields: must be an array" };
  }
  const requiredInstanceFields: string[] = [];
  for (const f of raw.auth.requiredInstanceFields) {
    const v = nfc(f);
    if (v === null) return { ok: false, error: "auth.requiredInstanceFields: entries must be strings" };
    requiredInstanceFields.push(v);
  }
  requiredInstanceFields.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // FLAT PROHIBITION: `requireUserToken !== true` never pends and never
  // resolves. Absent defaults to the ENFORCING value (matching the build-time
  // default on the public widget surface); an explicit `false` is refused.
  const requireUserToken = raw.auth.requireUserToken === undefined ? true : raw.auth.requireUserToken;
  if (requireUserToken !== true) {
    return { ok: false, error: "auth.requireUserToken: false is prohibited for runtime widget declarations" };
  }
  if (agentSlug === null || label === null || subjectNoun === null || skillCapability === null) {
    return { ok: false, error: "agentSlug/label/subjectNoun/skillCapability must be strings" };
  }
  if (resolveSingleStringExport(exportsField, moduleExportKey) === null) {
    return {
      ok: false,
      error: `moduleExportKey: "${moduleExportKey}" must resolve in package.json exports to a single string target`,
    };
  }
  const canon: WidgetStreamMetadataCanonV2 = {
    v: 2,
    agentSlug,
    packageName,
    moduleExportKey,
    factory,
    relayAgentPackage,
    skillCapability,
    contextFields,
    label,
    subjectNoun,
    auth: { tokenConfigKey, instancesConfigKey, requiredInstanceFields, requireUserToken: true },
  };
  const errors = validateWidgetStreamMetadataCanon(canon);
  if (errors.length > 0) return { ok: false, error: errors.join("; ") };
  const canonJson = canonicalJsonStringify(canon);
  return {
    ok: true,
    claim: {
      agentSlug,
      packageName,
      canon,
      canonJson,
      bindingHashV2: createHash("sha256").update(canonJson).digest("hex"),
    },
  };
}

/**
 * Read the widget-stream metadata claims a materialized (SRI-verified)
 * package's manifest declares. FAIL CLOSED, NEVER PARTIAL: a manifest that
 * cannot be read, carries a duplicate JSON key anywhere, or contains ANY
 * malformed/out-of-policy widgetStream entry (including a duplicate slug)
 * yields [] — the connector declares no runtime widget entry at all. The
 * refusal reason is logged (server console) so an operator can diagnose a
 * widget that never pends; the public surfaces stay opaque.
 */
export async function readWidgetStreamMetadataClaimsFromStore(
  storeDir: string,
): Promise<WidgetStreamMetadataGrantClaim[]> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  let raw: string;
  try {
    raw = await readFile(path.join(storeDir, "package.json"), "utf8");
  } catch {
    return [];
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed = parseJsonRejectingDuplicateKeys(raw);
    if (!isObj(parsed)) return [];
    manifest = parsed;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[widget-stream-metadata-grants] refusing manifest in ${storeDir}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
  const packageName = typeof manifest.name === "string" ? manifest.name.normalize("NFC") : null;
  if (packageName === null) return [];
  const cinatra = isObj(manifest.cinatra) ? manifest.cinatra : null;
  const declared = cinatra?.widgetStream;
  if (declared === undefined || declared === null) return [];
  const entries = Array.isArray(declared) ? declared : [declared];
  const claims: WidgetStreamMetadataGrantClaim[] = [];
  const slugs = new Set<string>();
  for (const entry of entries) {
    const result = buildClaimFromDeclaration(packageName, entry, manifest.exports);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[widget-stream-metadata-grants] ${packageName}: refusing ALL widgetStream entries (fail closed): ${result.error}`,
      );
      return [];
    }
    if (slugs.has(result.claim.agentSlug)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[widget-stream-metadata-grants] ${packageName}: duplicate agentSlug "${result.claim.agentSlug}" — refusing ALL entries`,
      );
      return [];
    }
    slugs.add(result.claim.agentSlug);
    claims.push(result.claim);
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

type MetadataRow = {
  id: string;
  package_name: string;
  org_id: string | null;
  agent_slug: string;
  binding_hash_v2: string;
  canon_json: string;
  status: string;
  approved_by: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  row_version: number;
};

export type WidgetStreamMetadataGrant = {
  id: string;
  packageName: string;
  orgId: string | null;
  agentSlug: string;
  bindingHashV2: string;
  canonJson: string;
  status: "pending" | "approved" | "revoked";
  approvedBy: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  rowVersion: number;
};

function wsmRowToGrant(row: MetadataRow): WidgetStreamMetadataGrant {
  return {
    id: row.id,
    packageName: row.package_name,
    orgId: row.org_id,
    agentSlug: row.agent_slug,
    bindingHashV2: row.binding_hash_v2,
    canonJson: row.canon_json,
    status: row.status as WidgetStreamMetadataGrant["status"],
    approvedBy: row.approved_by,
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at,
    rowVersion: Number(row.row_version),
  };
}

const WSM_SELECT_COLUMNS =
  "id, package_name, org_id, agent_slug, binding_hash_v2, canon_json, status, approved_by, revoked_by, revoked_at, row_version";


async function readWsmGrantRow(
  query: WidgetStreamMetadataGrantQuery,
  schema: string,
  packageName: string,
  orgId: string | null,
  agentSlug: string,
): Promise<WidgetStreamMetadataGrant | null> {
  const table = wsmQualifiedTable(schema);
  const { clause, value } = orgClause(orgId, 3);
  const values: unknown[] = [packageName, agentSlug];
  if (value !== null) values.push(value);
  const rows = await query<MetadataRow>(
    `SELECT ${WSM_SELECT_COLUMNS} FROM ${table}
      WHERE package_name = $1 AND agent_slug = $2 AND ${clause} LIMIT 1`,
    values,
  );
  return rows[0] ? wsmRowToGrant(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Record-time guards (the checks that need state beyond the claim itself)
// ---------------------------------------------------------------------------

/** Guards a record/reopen MUST run with — required, so a caller can never
 * forget them (fail-closed by construction, not by convention). */
export type WidgetStreamMetadataRecordGuards = {
  /** True when the slug is served by the BUILD-TIME generated map — build wins
   * absolutely; a colliding runtime claim never becomes a row. */
  isBuildTimeWidgetSlug: (agentSlug: string) => boolean | Promise<boolean>;
  /** The currently-APPROVED credential-store owner of a token key (the sibling
   * ownership grant's `resolveOwnershipOwner`) — the conjunction axis. */
  resolveCredentialStoreOwner: (tokenConfigKey: string, orgId: string | null) => Promise<string | null>;
};

export type RecordWidgetStreamMetadataResult =
  | { outcome: "recorded"; grant: WidgetStreamMetadataGrant }
  | { outcome: "refused"; reason: string };

export type RecordWidgetStreamMetadataInput = {
  packageName: string;
  orgId: string | null;
  claim: WidgetStreamMetadataGrantClaim;
};

async function refusalFor(
  input: RecordWidgetStreamMetadataInput,
  guards: WidgetStreamMetadataRecordGuards,
): Promise<string | null> {
  const { claim } = input;
  if (claim.packageName !== input.packageName || claim.canon.packageName !== input.packageName) {
    return `claim package "${claim.packageName}" does not match the installing package "${input.packageName}"`;
  }
  // FULL claim self-consistency (codex round-2 finding): the row key
  // (claim.agentSlug), the stored display JSON (claim.canonJson), and the
  // stored hash must all derive from the SAME canon — otherwise the canon an
  // admin is shown could be detached from the slug/hash being approved.
  if (claim.agentSlug !== claim.canon.agentSlug) {
    return `claim agentSlug "${claim.agentSlug}" does not match its canon ("${claim.canon.agentSlug}")`;
  }
  const errors = validateWidgetStreamMetadataCanon(claim.canon);
  if (errors.length > 0) return `invalid canon: ${errors.join("; ")}`;
  if (claim.canonJson !== canonicalJsonStringify(claim.canon)) {
    return "claim canonJson is not the canonical serialization of its canon (stale/forged claim)";
  }
  if (claim.bindingHashV2 !== computeWidgetStreamBindingHashV2(claim.canon)) {
    return "claim bindingHashV2 does not match its canon (stale/forged claim)";
  }
  if (await guards.isBuildTimeWidgetSlug(claim.agentSlug)) {
    return `agentSlug "${claim.agentSlug}" collides with a build-time widget-stream agent (build wins absolutely)`;
  }
  const owner = await guards.resolveCredentialStoreOwner(claim.canon.auth.tokenConfigKey, input.orgId);
  if (owner !== input.packageName) {
    return (
      `package is not the approved credential-store owner of token key "${claim.canon.auth.tokenConfigKey}" ` +
      `(owner: ${owner ?? "none"}) — the metadata grant is conjoined to the ownership grant`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API — record / approve (CAS) / revoke (sticky) / reopen / read /
// resolve / restore / delete-unapproved
// ---------------------------------------------------------------------------

/**
 * Record a widget-stream metadata claim. ALWAYS `pending` — there is NO
 * auto-approve on this axis for ANY trust tier.
 *
 * - Guard refusal (package mismatch, invalid canon, build-slug collision,
 *   ownership-conjunction failure) → `{ outcome: "refused" }`, no row touched.
 * - No existing row → insert `pending` at the claim's hash.
 * - Existing `revoked` row → PRESERVED UNTOUCHED whatever the hash (sticky
 *   revocation: an install never resurrects OR silently re-pends a tombstone).
 * - Existing row, SAME hash → untouched (preserves an existing approval).
 * - Existing row, DIFFERENT hash → reset to `pending` at the new hash
 *   (re-approval required after ANY canon change). The reset UPDATE itself
 *   refuses to touch a `revoked` row (race-proof stickiness).
 */
export async function recordRequestedWidgetStreamMetadataGrant(
  input: RecordWidgetStreamMetadataInput,
  guards: WidgetStreamMetadataRecordGuards,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<RecordWidgetStreamMetadataResult> {
  const { query, schema } = await wsmResolveDeps(deps);
  const table = wsmQualifiedTable(schema);
  const refusal = await refusalFor(input, guards);
  if (refusal !== null) return { outcome: "refused", reason: refusal };
  const { claim } = input;
  const existing = await readWsmGrantRow(query, schema, input.packageName, input.orgId, claim.agentSlug);

  if (existing && (existing.status === "revoked" || existing.bindingHashV2 === claim.bindingHashV2)) {
    return { outcome: "recorded", grant: existing };
  }

  if (existing) {
    const { clause, value } = orgClause(input.orgId, 5);
    const values: unknown[] = [claim.bindingHashV2, claim.canonJson, input.packageName, claim.agentSlug];
    if (value !== null) values.push(value);
    const rows = await query<MetadataRow>(
      `UPDATE ${table}
         SET binding_hash_v2 = $1,
             canon_json = $2,
             status = 'pending',
             approved_by = NULL,
             row_version = row_version + 1,
             updated_at = now()
       WHERE package_name = $3 AND agent_slug = $4 AND ${clause} AND status <> 'revoked'
       RETURNING ${WSM_SELECT_COLUMNS}`,
      values,
    );
    // 0 rows == the row became `revoked` between the read and the write —
    // stickiness wins; return the tombstone untouched.
    if (!rows[0]) {
      const now = await readWsmGrantRow(query, schema, input.packageName, input.orgId, claim.agentSlug);
      if (!now) throw new Error("extension_widget_stream_metadata_grant re-pend lost the row");
      return { outcome: "recorded", grant: now };
    }
    return { outcome: "recorded", grant: wsmRowToGrant(rows[0]) };
  }

  const rows = await query<MetadataRow>(
    `INSERT INTO ${table} (package_name, org_id, agent_slug, binding_hash_v2, canon_json, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING ${WSM_SELECT_COLUMNS}`,
    [input.packageName, input.orgId, claim.agentSlug, claim.bindingHashV2, claim.canonJson],
  );
  if (!rows[0]) throw new Error("extension_widget_stream_metadata_grant insert returned no row");
  return { outcome: "recorded", grant: wsmRowToGrant(rows[0]) };
}

/** Typed CAS conflict — the admin surface re-displays the CURRENT canon. */
export class WidgetStreamMetadataApprovalConflictError extends Error {
  readonly code:
    | "no-grant"
    | "not-pending-approved"
    | "not-pending-revoked"
    | "binding-hash-changed";
  constructor(code: WidgetStreamMetadataApprovalConflictError["code"], message: string) {
    super(message);
    this.name = "WidgetStreamMetadataApprovalConflictError";
    this.code = code;
  }
}

export type ApproveWidgetStreamMetadataInput = {
  packageName: string;
  orgId: string | null;
  agentSlug: string;
  approvedBy: string;
  /** REQUIRED: the exact hash the admin was shown. Not optional — an approval
   * without a basis would be an approval of a canon nobody verifiably saw. */
  expectedBindingHashV2: string;
};

/**
 * Approve a metadata grant — transactional COMPARE-AND-SWAP on the displayed
 * hash. The single UPDATE succeeds only while the row is still `pending` AT
 * `expectedBindingHashV2` for the named package; anything else (an install
 * re-pended the row to a new hash, a revocation landed, the row vanished)
 * throws a typed conflict and the admin must re-view the current canon. A
 * second approved grant for the same slug/scope is a DB write-time
 * impossibility (`..._approved_slug_uniq` / `..._approved_slug_global_uniq`
 * partial unique indexes) — squatting surfaces as a unique violation.
 */
export async function approveWidgetStreamMetadataGrant(
  input: ApproveWidgetStreamMetadataInput,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<WidgetStreamMetadataGrant> {
  const { query, schema } = await wsmResolveDeps(deps);
  const table = wsmQualifiedTable(schema);
  const { clause, value } = orgClause(input.orgId, 5);
  const values: unknown[] = [input.approvedBy, input.packageName, input.agentSlug, input.expectedBindingHashV2];
  if (value !== null) values.push(value);
  const rows = await query<MetadataRow>(
    `UPDATE ${table}
       SET status = 'approved',
           approved_by = $1,
           row_version = row_version + 1,
           updated_at = now()
     WHERE package_name = $2 AND agent_slug = $3 AND binding_hash_v2 = $4
       AND status = 'pending' AND ${clause}
     RETURNING ${WSM_SELECT_COLUMNS}`,
    values,
  );
  if (rows[0]) return wsmRowToGrant(rows[0]);
  const current = await readWsmGrantRow(query, schema, input.packageName, input.orgId, input.agentSlug);
  if (!current) {
    throw new WidgetStreamMetadataApprovalConflictError(
      "no-grant",
      `No widget-stream metadata grant for ${input.packageName} (slug=${input.agentSlug}, org=${input.orgId ?? "global"})`,
    );
  }
  if (current.status === "revoked") {
    throw new WidgetStreamMetadataApprovalConflictError(
      "not-pending-revoked",
      `Grant for ${input.packageName}/${input.agentSlug} is revoked (tombstoned); an explicit admin reopen is required before approval`,
    );
  }
  if (current.bindingHashV2 !== input.expectedBindingHashV2) {
    throw new WidgetStreamMetadataApprovalConflictError(
      "binding-hash-changed",
      `The widget definition for ${input.packageName}/${input.agentSlug} changed since it was displayed; re-view the current canon before approving`,
    );
  }
  throw new WidgetStreamMetadataApprovalConflictError(
    "not-pending-approved",
    `Grant for ${input.packageName}/${input.agentSlug} is not pending (status=${current.status})`,
  );
}

export type RevokeWidgetStreamMetadataInput = {
  packageName: string;
  orgId: string | null;
  agentSlug: string;
  revokedBy: string;
};

/**
 * Revoke a metadata grant — a DURABLE TOMBSTONE. The row keeps existing (grant
 * identity is durable); installs can neither resurrect nor silently re-pend
 * it; only the explicit admin reopen below reconsiders it.
 */
export async function revokeWidgetStreamMetadataGrant(
  input: RevokeWidgetStreamMetadataInput,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<WidgetStreamMetadataGrant | null> {
  const { query, schema } = await wsmResolveDeps(deps);
  const table = wsmQualifiedTable(schema);
  const { clause, value } = orgClause(input.orgId, 4);
  const values: unknown[] = [input.revokedBy, input.packageName, input.agentSlug];
  if (value !== null) values.push(value);
  const rows = await query<MetadataRow>(
    `UPDATE ${table}
       SET status = 'revoked',
           approved_by = NULL,
           revoked_by = $1,
           revoked_at = now(),
           row_version = row_version + 1,
           updated_at = now()
     WHERE package_name = $2 AND agent_slug = $3 AND ${clause}
     RETURNING ${WSM_SELECT_COLUMNS}`,
    values,
  );
  return rows[0] ? wsmRowToGrant(rows[0]) : null;
}

export type ReopenWidgetStreamMetadataInput = {
  packageName: string;
  orgId: string | null;
  agentSlug: string;
  /** The CURRENT on-disk claim (re-read from the materialized store) — the
   * reopened row pends at the canon an admin will actually be shown. */
  claim: WidgetStreamMetadataGrantClaim;
};

/**
 * The EXPLICIT admin action that reconsiders a revoked grant: `revoked` →
 * `pending` at the CURRENT claim. Runs the same record-time guards as a fresh
 * record (a reopen must not admit a claim a record would refuse). Only ever
 * transitions a `revoked` row; anything else throws.
 */
export async function reopenRevokedWidgetStreamMetadataGrant(
  input: ReopenWidgetStreamMetadataInput,
  guards: WidgetStreamMetadataRecordGuards,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<WidgetStreamMetadataGrant> {
  const { query, schema } = await wsmResolveDeps(deps);
  const table = wsmQualifiedTable(schema);
  if (input.agentSlug !== input.claim.agentSlug) {
    throw new Error(
      `reopenRevokedWidgetStreamMetadataGrant refused: claim is for slug "${input.claim.agentSlug}", not "${input.agentSlug}"`,
    );
  }
  const refusal = await refusalFor(
    { packageName: input.packageName, orgId: input.orgId, claim: input.claim },
    guards,
  );
  if (refusal !== null) {
    throw new Error(`reopenRevokedWidgetStreamMetadataGrant refused: ${refusal}`);
  }
  const { clause, value } = orgClause(input.orgId, 5);
  const values: unknown[] = [input.claim.bindingHashV2, input.claim.canonJson, input.packageName, input.agentSlug];
  if (value !== null) values.push(value);
  const rows = await query<MetadataRow>(
    `UPDATE ${table}
       SET status = 'pending',
           binding_hash_v2 = $1,
           canon_json = $2,
           approved_by = NULL,
           revoked_by = NULL,
           revoked_at = NULL,
           row_version = row_version + 1,
           updated_at = now()
     WHERE package_name = $3 AND agent_slug = $4 AND ${clause} AND status = 'revoked'
     RETURNING ${WSM_SELECT_COLUMNS}`,
    values,
  );
  if (!rows[0]) {
    throw new Error(
      `reopenRevokedWidgetStreamMetadataGrant: no revoked grant for ${input.packageName}/${input.agentSlug} (org=${input.orgId ?? "global"})`,
    );
  }
  return wsmRowToGrant(rows[0]);
}

export type ReadWidgetStreamMetadataGrantInput = {
  packageName: string;
  orgId: string | null;
  agentSlug: string;
};

/** Read the exact-scope grant row (no global fallback) — prior-state capture
 * for durable rollback + the admin surface. */
export async function readWidgetStreamMetadataGrant(
  input: ReadWidgetStreamMetadataGrantInput,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<WidgetStreamMetadataGrant | null> {
  const { query, schema } = await wsmResolveDeps(deps);
  return readWsmGrantRow(query, schema, input.packageName, input.orgId, input.agentSlug);
}

export type ResolveApprovedWidgetStreamMetadataInput = {
  agentSlug: string;
  orgId: string | null;
};

/**
 * Resolve the UNIQUE `approved` metadata grant for a slug, fail-closed. An
 * org-scoped approved grant takes precedence over a global one (mirrors the
 * ownership resolver; the pilot records at global scope). Zero or ambiguous →
 * null → the runtime resolver arm 404s. This is the AUTHORITY read the
 * runtime resolver arm (a later slice) unions with the build-time map — the
 * on-disk canon re-hash, trust classification, and ownership conjunction are
 * re-asserted THERE, at every point of use.
 */
export async function resolveApprovedWidgetStreamMetadataGrant(
  input: ResolveApprovedWidgetStreamMetadataInput,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<WidgetStreamMetadataGrant | null> {
  const { query, schema } = await wsmResolveDeps(deps);
  const table = wsmQualifiedTable(schema);
  if (input.orgId !== null) {
    const orgRows = await query<MetadataRow>(
      `SELECT ${WSM_SELECT_COLUMNS} FROM ${table}
        WHERE agent_slug = $1 AND org_id = $2 AND status = 'approved' LIMIT 2`,
      [input.agentSlug, input.orgId],
    );
    if (orgRows.length === 1) return wsmRowToGrant(orgRows[0]!);
    if (orgRows.length > 1) return null; // defensive: index makes this impossible
  }
  const globalRows = await query<MetadataRow>(
    `SELECT ${WSM_SELECT_COLUMNS} FROM ${table}
      WHERE agent_slug = $1 AND org_id IS NULL AND status = 'approved' LIMIT 2`,
    [input.agentSlug],
  );
  if (globalRows.length === 1) return wsmRowToGrant(globalRows[0]!);
  return null; // 0 approved (fail closed) or >1 (defensive)
}

export type RestoreWidgetStreamMetadataInput = {
  packageName: string;
  orgId: string | null;
  agentSlug: string;
  status: "pending" | "approved" | "revoked";
  bindingHashV2: string;
  canonJson: string;
  approvedBy: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
};

/**
 * DIRECTLY restore a grant row to a previously-captured, already-valid state
 * (durable rollback of a failed UPDATE install — mirrors the ownership grant's
 * restore). Used ONLY on the rollback path, never forward. STICKINESS GUARD:
 * a restore of a non-`revoked` captured state refuses to overwrite a row that
 * is CURRENTLY `revoked` (an admin may have revoked mid-install; a rollback
 * must never launder that revocation away) — in that case the tombstone wins
 * and is returned unchanged.
 */
export async function restoreWidgetStreamMetadataGrant(
  input: RestoreWidgetStreamMetadataInput,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<WidgetStreamMetadataGrant> {
  const { query, schema } = await wsmResolveDeps(deps);
  const table = wsmQualifiedTable(schema);
  const existing = await readWsmGrantRow(query, schema, input.packageName, input.orgId, input.agentSlug);
  if (existing) {
    const stickiness = input.status === "revoked" ? "" : " AND status <> 'revoked'";
    const { clause, value } = orgClause(input.orgId, 9);
    const values: unknown[] = [
      input.status,
      input.bindingHashV2,
      input.canonJson,
      input.approvedBy,
      input.revokedBy,
      input.revokedAt,
      input.packageName,
      input.agentSlug,
    ];
    if (value !== null) values.push(value);
    const rows = await query<MetadataRow>(
      `UPDATE ${table}
         SET status = $1,
             binding_hash_v2 = $2,
             canon_json = $3,
             approved_by = $4,
             revoked_by = $5,
             revoked_at = $6,
             row_version = row_version + 1,
             updated_at = now()
       WHERE package_name = $7 AND agent_slug = $8 AND ${clause}${stickiness}
       RETURNING ${WSM_SELECT_COLUMNS}`,
      values,
    );
    if (rows[0]) return wsmRowToGrant(rows[0]);
    const now = await readWsmGrantRow(query, schema, input.packageName, input.orgId, input.agentSlug);
    if (!now) throw new Error("extension_widget_stream_metadata_grant restore lost the row");
    return now; // the tombstone won
  }
  const rows = await query<MetadataRow>(
    `INSERT INTO ${table} (package_name, org_id, agent_slug, binding_hash_v2, canon_json, status, approved_by, revoked_by, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${WSM_SELECT_COLUMNS}`,
    [
      input.packageName,
      input.orgId,
      input.agentSlug,
      input.bindingHashV2,
      input.canonJson,
      input.status,
      input.approvedBy,
      input.revokedBy,
      input.revokedAt,
    ],
  );
  if (!rows[0]) throw new Error("extension_widget_stream_metadata_grant restore insert returned no row");
  return wsmRowToGrant(rows[0]);
}

export type DeleteUnapprovedWidgetStreamMetadataInput = {
  packageName: string;
  orgId: string | null;
  agentSlug: string;
  /** Only the row THIS attempt recorded is deletable — pinned by its hash. */
  bindingHashV2: string;
};

/**
 * FRESH-install rollback: delete the still-`pending`, never-approved row this
 * attempt inserted — and ONLY that row (status `pending`, no approver, at the
 * exact hash this attempt wrote). An `approved` or `revoked` row is never
 * deletable through this module (durable grant identity: history cannot be
 * recreated to launder a revocation). Unlike the ownership grant's
 * fresh-rollback REVOKE, deleting is correct here: a pending metadata row was
 * never authority (no auto-approve exists on this axis), while revoking it
 * would fabricate an admin-meaning tombstone no admin created.
 */
export async function deleteUnapprovedWidgetStreamMetadataGrant(
  input: DeleteUnapprovedWidgetStreamMetadataInput,
  deps?: WidgetStreamMetadataGrantDeps,
): Promise<boolean> {
  const { query, schema } = await wsmResolveDeps(deps);
  const table = wsmQualifiedTable(schema);
  const { clause, value } = orgClause(input.orgId, 4);
  const values: unknown[] = [input.packageName, input.agentSlug, input.bindingHashV2];
  if (value !== null) values.push(value);
  const rows = await query<Pick<MetadataRow, "id">>(
    `DELETE FROM ${table}
      WHERE package_name = $1 AND agent_slug = $2 AND binding_hash_v2 = $3 AND ${clause}
        AND status = 'pending' AND approved_by IS NULL
      RETURNING id`,
    values,
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Install-pipeline integration (reached VIA `extension-capability-ownership-
// grants.ts` — the pipeline's existing grant step-helpers delegate here, so
// the pipeline itself gains no logic and no new import).
// ---------------------------------------------------------------------------

/** The install-pipeline hooks for the widget-stream metadata grant lifecycle.
 * All optional so existing pipeline unit tests can omit them (then no metadata
 * grant is recorded — a pure no-op leaving the runtime widget authority axis
 * empty, which fails closed); `makeWidgetStreamMetadataGrantInstallDeps()`
 * wires all five. */
export type WidgetStreamMetadataGrantInstallHooks = {
  /** Read the widget-stream metadata claims the materialized (SRI-verified)
   * manifest declares (`cinatra.widgetStream[]`), fail-closed-never-partial. */
  readWidgetStreamMetadataClaims?: (storeDir: string) => Promise<WidgetStreamMetadataGrantClaim[]>;
  /** Record ONE claim `pending` (guards inside; NEVER auto-approves). */
  recordWidgetStreamMetadataGrant?: (input: RecordWidgetStreamMetadataInput) => Promise<void>;
  /** Exact-scope row read — prior-state capture for durable rollback. */
  readWidgetStreamMetadataGrant?: (
    packageName: string,
    orgId: string | null,
    agentSlug: string,
  ) => Promise<CapturedWidgetStreamMetadataGrant | null>;
  /** Durable rollback: re-write the OLD grant row to its captured state
   * (revocation-sticky — see `restoreWidgetStreamMetadataGrant`). */
  restoreWidgetStreamMetadataGrant?: (input: RestoreWidgetStreamMetadataInput) => Promise<void>;
  /** FRESH-install rollback: delete the still-pending row this attempt wrote. */
  deleteUnapprovedWidgetStreamMetadataGrant?: (
    input: DeleteUnapprovedWidgetStreamMetadataInput,
  ) => Promise<void>;
};

export type CapturedWidgetStreamMetadataGrant = {
  agentSlug: string;
  status: "pending" | "approved" | "revoked";
  bindingHashV2: string;
  canonJson: string;
  approvedBy: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
};

/**
 * Capture the prior metadata grants (one per slug the NEW manifest claims) for
 * durable rollback — `recordRequestedWidgetStreamMetadataGrant` may re-pend a
 * prior approval against the new canon before a later throw, so a failed
 * install must re-pin the prior grant state on the unwind paths. UNLIKE the
 * ownership capture this is NOT update-gated (codex round-2 finding): a grant
 * row's lifetime is the durable `(package, slug)` identity, not one install's
 * — a "fresh" reinstall after an uninstall can meet a pre-existing row, and
 * the unwind must RESTORE it rather than treat it as this attempt's insert
 * (the hash-pinned delete is reserved for a slug that truly had no row before
 * this attempt; same-package installs are serialized by the install locks).
 * Empty when the reader is unwired.
 */
export async function capturePriorWidgetStreamMetadataGrants(
  hooks: Pick<WidgetStreamMetadataGrantInstallHooks, "readWidgetStreamMetadataGrant">,
  args: {
    packageName: string;
    orgId: string | null;
    claims: readonly WidgetStreamMetadataGrantClaim[];
  },
): Promise<CapturedWidgetStreamMetadataGrant[]> {
  if (!hooks.readWidgetStreamMetadataGrant) return [];
  const read = hooks.readWidgetStreamMetadataGrant;
  const captured = await Promise.all(
    args.claims.map((claim) => read(args.packageName, args.orgId, claim.agentSlug)),
  );
  return captured.filter((g): g is CapturedWidgetStreamMetadataGrant => g !== null);
}

/**
 * Record every declared claim as a PENDING metadata grant. Deliberately NO
 * `autoGrantPrivileged` parameter: unlike ports / host DDL / credential-store
 * ownership, the metadata axis is NEVER auto-approved for any tier — an admin
 * must approve the displayed canon explicitly. A guard REFUSAL (slug collision,
 * ownership-conjunction failure, invalid canon) records nothing for that claim
 * and does not abort the install (the connector simply has no runtime widget
 * until fixed — fail closed); a DB error still propagates (fail loud). A pure
 * no-op when the recorder is unwired.
 */
export async function recordWidgetStreamMetadataGrants(
  hooks: Pick<WidgetStreamMetadataGrantInstallHooks, "recordWidgetStreamMetadataGrant">,
  args: {
    claims: readonly WidgetStreamMetadataGrantClaim[];
    packageName: string;
    orgId: string | null;
  },
): Promise<void> {
  if (!hooks.recordWidgetStreamMetadataGrant) return;
  for (const claim of args.claims) {
    await hooks.recordWidgetStreamMetadataGrant({
      packageName: args.packageName,
      orgId: args.orgId,
      claim,
    });
  }
}

/**
 * Undo THIS install attempt's metadata grant writes on a rollback path. For
 * each claimed slug: a captured prior row (whatever install it came from —
 * capture is not update-gated) is re-pinned to its EXACT state
 * (revocation-sticky); only a slug with NO row before this attempt gets the
 * hash-pinned delete of the still-pending row this attempt inserted.
 * Best-effort + isolated per slug: a failure is reported via `onFailure` and
 * never masks the original install error.
 */
export async function unwindWidgetStreamMetadataGrants(args: {
  hooks: Pick<
    WidgetStreamMetadataGrantInstallHooks,
    "restoreWidgetStreamMetadataGrant" | "deleteUnapprovedWidgetStreamMetadataGrant"
  >;
  packageName: string;
  orgId: string | null;
  claims: readonly WidgetStreamMetadataGrantClaim[];
  priorGrants: readonly CapturedWidgetStreamMetadataGrant[];
  onFailure: (error: unknown) => void;
}): Promise<void> {
  const { hooks, packageName, orgId, claims, priorGrants, onFailure } = args;
  if (!hooks.restoreWidgetStreamMetadataGrant && !hooks.deleteUnapprovedWidgetStreamMetadataGrant) return;
  const priorBySlug = new Map(priorGrants.map((g) => [g.agentSlug, g]));
  for (const claim of claims) {
    const prior = priorBySlug.get(claim.agentSlug);
    try {
      if (prior && hooks.restoreWidgetStreamMetadataGrant) {
        await hooks.restoreWidgetStreamMetadataGrant({
          packageName,
          orgId,
          agentSlug: claim.agentSlug,
          status: prior.status,
          bindingHashV2: prior.bindingHashV2,
          canonJson: prior.canonJson,
          approvedBy: prior.approvedBy,
          revokedBy: prior.revokedBy,
          revokedAt: prior.revokedAt,
        });
      } else if (!prior && hooks.deleteUnapprovedWidgetStreamMetadataGrant) {
        await hooks.deleteUnapprovedWidgetStreamMetadataGrant({
          packageName,
          orgId,
          agentSlug: claim.agentSlug,
          bindingHashV2: claim.bindingHashV2,
        });
      }
    } catch (e) {
      onFailure(e);
    }
  }
}

/**
 * The metadata-grant lifecycle hooks for the pipeline deps factory. The
 * conjunction resolver is INJECTED by the caller (the sibling ownership-grant
 * module passes its own `resolveOwnershipOwner`) — this module never imports
 * that module, keeping the dependency direction acyclic. The build-slug guard
 * defaults to a lazy literal import of the generated map (kept out of this
 * module's static graph on purpose).
 */
export function makeWidgetStreamMetadataGrantInstallDeps(wiring: {
  resolveCredentialStoreOwner: (tokenConfigKey: string, orgId: string | null) => Promise<string | null>;
  isBuildTimeWidgetSlug?: (agentSlug: string) => boolean | Promise<boolean>;
}): WidgetStreamMetadataGrantInstallHooks {
  const guards: WidgetStreamMetadataRecordGuards = {
    resolveCredentialStoreOwner: wiring.resolveCredentialStoreOwner,
    isBuildTimeWidgetSlug:
      wiring.isBuildTimeWidgetSlug ??
      (async (agentSlug: string) =>
        Boolean(
          (await import("@/lib/generated/extensions.server")).GENERATED_WIDGET_STREAM_AGENTS[agentSlug],
        )),
  };
  return {
    readWidgetStreamMetadataClaims: (storeDir) => readWidgetStreamMetadataClaimsFromStore(storeDir),
    recordWidgetStreamMetadataGrant: async (input) => {
      const result = await recordRequestedWidgetStreamMetadataGrant(input, guards);
      if (result.outcome === "refused") {
        // Structured server-side diagnostic (the design routes detailed reasons
        // to logs/audit, never to a public response body).
        // eslint-disable-next-line no-console
        console.warn(
          `[widget-stream-metadata-grants] refused claim ${input.packageName}/${input.claim.agentSlug}: ${result.reason}`,
        );
      }
    },
    readWidgetStreamMetadataGrant: async (packageName, orgId, agentSlug) => {
      const g = await readWidgetStreamMetadataGrant({ packageName, orgId, agentSlug });
      return g
        ? {
            agentSlug: g.agentSlug,
            status: g.status,
            bindingHashV2: g.bindingHashV2,
            canonJson: g.canonJson,
            approvedBy: g.approvedBy,
            revokedBy: g.revokedBy,
            revokedAt: g.revokedAt,
          }
        : null;
    },
    restoreWidgetStreamMetadataGrant: (i) => restoreWidgetStreamMetadataGrant(i).then(() => undefined),
    deleteUnapprovedWidgetStreamMetadataGrant: (i) =>
      deleteUnapprovedWidgetStreamMetadataGrant(i).then(() => undefined),
  };
}
