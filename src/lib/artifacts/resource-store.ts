import "server-only";
import { randomUUID, createHash } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";

// ---------------------------------------------------------------------------
// Resource backend layer.
//
// A `resource` is the concrete bytes-or-pointer the system stores, dedupes,
// audits, malware-scans. Identity = its SUBSTANCE, not its id: the
// `substance_key` is canonical AND namespaced per kind. `etag` alone is a
// footgun; a dashboard fingerprint needs canonical sorted-JSON, not raw
// stringify. Dedupe is `(org_id, kind, substance_key)`. One resource may
// underlie representations of many artifacts (multi-artifact attribution).
// Backend-only — no user-facing "resource" noun.
// ---------------------------------------------------------------------------

export type ResourceKind = "blob" | "connector" | "dashboard";
export type MalwareScanStatus = "pending" | "clean" | "flagged" | "skipped";

export type ResourceRecord = {
  id: string;
  orgId: string;
  kind: ResourceKind;
  substanceKey: string;
  mime: string;
  sizeBytes: number;
  malwareScanStatus: MalwareScanStatus;
  createdBy: string | null;
  createdAt: string;
};

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Deterministic canonical JSON: object keys recursively sorted, no
 * whitespace. Two view-specs that differ only by key order / formatting
 * MUST produce the SAME string (so they dedupe to one resource). Arrays
 * keep order (order is semantically meaningful in a view-spec).
 */
/**
 * Reject anything that does NOT serialize to deterministic JSON. Silent
 * JSON.stringify quirks would collide distinct view-specs:
 * `{a:undefined}`≡`{}`, NaN/Infinity→null, Date→`{}`, bigint throws, a
 * function/symbol drops. A view-spec MUST be plain JSON — anything else is
 * a real authoring bug; fail LOUD, never silently dedupe-collide.
 */
export function assertJSONSafe(value: unknown, path = "<root>"): void {
  if (value === null) return;
  const t = typeof value;
  if (t === "string" || t === "boolean") return;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error(`resource view-spec not JSON-safe at ${path}: non-finite number`);
    }
    return;
  }
  if (t === "undefined" || t === "bigint" || t === "function" || t === "symbol") {
    throw new Error(`resource view-spec not JSON-safe at ${path}: ${t}`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJSONSafe(v, `${path}[${i}]`));
    return;
  }
  // plain object only — reject Date/Map/Set/class instances (ambiguous JSON)
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`resource view-spec not JSON-safe at ${path}: non-plain object (${(value as object).constructor?.name ?? "?"})`);
  }
  for (const k of Object.keys(value as object)) {
    assertJSONSafe((value as Record<string, unknown>)[k], `${path}.${k}`);
  }
}

export function canonicalJSONStringify(value: unknown): string {
  assertJSONSafe(value);
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(norm);
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = norm(o[k]);
    return out;
  };
  return JSON.stringify(norm(value));
}

export type SubstanceInput =
  | { kind: "blob"; sha256: string }
  | {
      kind: "connector";
      connectorKind: string;
      accountScope: string;
      externalObjectId: string;
      revisionOrEtag: string;
      resolvedMime: string;
    }
  | { kind: "dashboard"; viewSpec: unknown };

/**
 * Canonical + namespaced substance key. Every component is colon-joined and
 * each free component is itself sha256'd-into-the-whole only for dashboard
 * (large/structured); connector parts are individually present so a stale
 * etag changes the key (new revision ⇒ new resource, never a wrong dedupe).
 */
export function deriveSubstanceKey(input: SubstanceInput): string {
  switch (input.kind) {
    case "blob":
      return `blob:${input.sha256}`;
    case "connector":
      // encodeURIComponent is bijective here (encodes BOTH ':' and '%'), so
      // no two distinct connector tuples can ever produce the same key —
      // unlike a non-bijective `:`→`%3A` replace.
      return [
        "connector",
        input.connectorKind,
        input.accountScope,
        input.externalObjectId,
        input.revisionOrEtag,
        input.resolvedMime,
      ]
        .map((p) => encodeURIComponent(String(p)))
        .join(":");
    case "dashboard":
      return `dashboard:${sha256(canonicalJSONStringify(input.viewSpec))}`;
  }
}

function conn(): string {
  return getPostgresConnectionString();
}
function q(): string {
  return postgresSchema.replaceAll('"', '""');
}

/**
 * Dedupe-on-substance upsert. If a resource with the same
 * (org_id, kind, substance_key) exists, return IT (id, existing scan
 * status) — never a duplicate row. Otherwise insert. `mime`/`size_bytes`
 * on a hit are NOT overwritten (substance identity is immutable; a changed
 * mime/size would be a different substance ⇒ different key).
 */
export function upsertResource(input: {
  orgId: string;
  kind: ResourceKind;
  substanceKey: string;
  mime: string;
  sizeBytes: number;
  createdBy?: string | null;
  metadata?: Record<string, unknown>;
}): ResourceRecord {
  ensurePostgresSchema();
  const id = randomUUID();
  const res = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `INSERT INTO "${q()}"."resource"
  (id, org_id, kind, substance_key, mime, size_bytes, created_by, metadata)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
ON CONFLICT (org_id, kind, substance_key) DO UPDATE SET org_id = EXCLUDED.org_id
RETURNING id, org_id, kind, substance_key, mime, size_bytes, malware_scan_status, created_by, created_at`,
        values: [
          id,
          input.orgId,
          input.kind,
          input.substanceKey,
          input.mime,
          input.sizeBytes,
          input.createdBy ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
      },
    ],
  });
  const row = (res?.[0]?.rows?.[0] ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id ?? id),
    orgId: String(row.org_id ?? input.orgId),
    kind: (row.kind as ResourceKind) ?? input.kind,
    substanceKey: String(row.substance_key ?? input.substanceKey),
    mime: String(row.mime ?? input.mime),
    sizeBytes: Number(row.size_bytes ?? input.sizeBytes),
    malwareScanStatus: (row.malware_scan_status as MalwareScanStatus) ?? "pending",
    createdBy: (row.created_by as string | null) ?? input.createdBy ?? null,
    createdAt: String(row.created_at ?? ""),
  };
}

export function getResource(orgId: string, id: string): ResourceRecord | null {
  ensurePostgresSchema();
  const res = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT id, org_id, kind, substance_key, mime, size_bytes, malware_scan_status, created_by, created_at
FROM "${q()}"."resource" WHERE org_id = $1 AND id = $2 LIMIT 1`,
        values: [orgId, id],
      },
    ],
  });
  const row = res?.[0]?.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    kind: row.kind as ResourceKind,
    substanceKey: String(row.substance_key),
    mime: String(row.mime),
    sizeBytes: Number(row.size_bytes),
    malwareScanStatus: row.malware_scan_status as MalwareScanStatus,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

/** Org-scoped malware-scan status transition (the only mutable column). */
export function setMalwareScanStatus(
  orgId: string,
  id: string,
  status: MalwareScanStatus,
): void {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `UPDATE "${q()}"."resource" SET malware_scan_status = $3 WHERE org_id = $1 AND id = $2`,
        values: [orgId, id, status],
      },
    ],
  });
}
