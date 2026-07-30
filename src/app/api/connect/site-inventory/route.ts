import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

import { getPooledDb } from "@/lib/db/pooled";
import { logAuditEvent } from "@/lib/authz/audit";
import type { WordPressInstanceRow } from "@/lib/connector-client-providers";
import { readConnectorConfigFromDatabase } from "@/lib/database";
import {
  resolveCanonicalInstanceForOrigin,
  resolveVerifiedSiteFromCredential,
} from "@/lib/widget-user-auth";
import {
  SUPPORTED_SITE_INVENTORY_VERSIONS,
  wpSiteInventoryV1Schema,
} from "@/lib/connector-instance-site-inventory-contract";
import {
  applySiteInventory,
  type WordPressServerEnrollmentDeps,
  type WordPressServerEnrollmentStore,
} from "@/lib/connector-instance-server-enrollment";
import {
  deleteManualServer,
  deletePresentUnenrolledServer,
  ensureDefaultServerEnrollment,
  listInstanceServers,
  recordServerStatus,
  retireServer,
  tryAdvanceSiteInventory,
  upsertServer,
  type ServerStoreQuery,
} from "@/lib/connector-instance-server-store";
import {
  allowSiteInventoryRequest,
  checkSiteInventoryDebounce,
  markSiteInventoryAccepted,
} from "@/lib/site-inventory-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// cinatra#2021 (S6) — POST /api/connect/site-inventory
//
// This is cinatra#2018 (S3)'s never-built "PR-D": the authenticated intake
// route the S3 contract (`connector-instance-site-inventory-contract.ts`),
// reconciler (`connector-instance-server-enrollment.ts`) and anti-replay store
// (`connector-instance-server-store.ts`) were all designed and merged around,
// but which had NO production caller until this route. S6's own "enrichment
// payload lands in the S3 store" acceptance criterion has nowhere to land
// without it, so S6 absorbs PR-D's exact, already-designed scope: one route +
// the one-line auth-route-guard exemption. Nothing here is a new design — the
// full spec lives in `docs/internals/contracts/wp-site-inventory-contract.md`.
//
// Server-to-server; no session/cookies. `Authorization: Bearer cnx_<siteId>_
// <secret>` IS the authentication (constant-time hash vs `connect_sites`); the
// paired `Origin` header is a binding/consistency check only.
//
// SECURITY POSTURE (fail-closed on every verification step):
//   - Pre-auth (credential / origin / instance-association / org-cross-check
//     / body-size / JSON-shape) failures ALL return the SAME generic
//     `400 {"error":"invalid_request"}` — no oracle distinguishes which check
//     failed. Only once the sender's identity + instance binding is
//     established does the response get more specific (contract version /
//     payload shape / replay staleness).
//   - The credential is validated BEFORE the request body is ever read, so an
//     unauthenticated/invalid-credential caller's body is never buffered —
//     the first line of payload-bomb defense. A body that DOES get read is
//     bounded to the contract's 256 KB cap by a chunked, cap-checked stream
//     read (never trusts `Content-Length` alone: it can be absent, wrong, or
//     the transfer can be chunked-encoded).
//   - The anti-replay `(credentialVersion, inventorySeq)` gate and the
//     reconciler's server-row diff run inside ONE Postgres transaction (the
//     S3 round-1 atomicity fix): a failed apply rolls the accepted-sequence
//     advance back with it, so the two can never diverge under a race.
//   - The pre-auth limiter charges BOTH a best-effort IP bucket AND a
//     credential-hash bucket (the stable secondary key — rotating the
//     forwarded-for header under one credential is still throttled), with a
//     bounded bucket table that fails CLOSED at saturation. The per-site
//     debounce window is recorded only after a successful COMMIT, so a
//     rejected send never burns a legit sender's retry slot.
//   - Secrets (the `cnx_` credential) are never logged; the limiter holds
//     only a hash of it; audit metadata never carries credential material or
//     the caller IP (the IP travels only in the audit event's dedicated,
//     typed field), only ids/reasons/counts.
//
// DELIBERATE SCOPE LIMIT (disclosed, non-blocking): this route does not wire
// in-process catalog-cache invalidation (`onServerInvalidated`) — that
// plumbing lives in the host binder (`register-host-connector-services.ts`),
// which this route intentionally does not import (routes consume `src/lib`
// siblings; only the binder wires vendor-specific cache/probe modules,
// preserving the architecture the S2/S3 modules were built against). Newly
// enrolled/updated servers are still visible immediately (`listEnrolledServers`
// is a live DB read, never cached) and a retired server is unreachable
// immediately regardless of cache state (the invoker's acquire loop filters by
// current DB status — S3 design §6 "removed-server fail-closed beats stale
// cache"). The one residual: a `restPath` change on an already-enrolled
// discovered server may keep serving its OLD cached endpoint for up to the
// existing 5-minute catalog TTL. Cosmetic/non-security; a follow-on can wire
// invalidation once a route/host-side consumer needs the tighter bound.
// ---------------------------------------------------------------------------

const CONNECTOR_KEY = "wordpress" as const;
const MAX_BODY_BYTES = 256 * 1024; // contract "Channel": 256 KB cap

const GENERIC_400 = { error: "invalid_request" } as const;

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function generic400(): NextResponse {
  return NextResponse.json(GENERIC_400, { status: 400 });
}

function rateLimited(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

/** Best-effort audit — never throws into the response path (mirrors every
 * other connect/* route's audit posture: the audit sink is a side channel,
 * not a correctness dependency). The caller IP travels ONLY in the audit
 * event's dedicated typed field — never duplicated into the free-form
 * metadata blob, which has different retention/redaction handling. */
async function auditReject(
  reason: string,
  fields: { ip?: string; siteId?: string; instanceId?: string } = {},
): Promise<void> {
  const { ip, ...nonPiiFields } = fields;
  try {
    await logAuditEvent({
      resourceType: "connector_instance",
      resourceId: nonPiiFields.instanceId ?? "unresolved",
      actorPrincipalType: "system",
      authSource: "route",
      operation: "enrichment_rejected",
      decision: "denied",
      policyVersion: "connector-instance-site-inventory-intake",
      ip,
      metadata: { connectorKey: CONNECTOR_KEY, reason, ...nonPiiFields },
    });
  } catch {
    /* audit is best-effort */
  }
}

async function auditAccept(fields: {
  siteId: string;
  instanceId: string;
  enrolled: number;
  presentUnenrolled: number;
  retired: number;
}): Promise<void> {
  try {
    await logAuditEvent({
      resourceType: "connector_instance",
      resourceId: fields.instanceId,
      actorPrincipalType: "system",
      authSource: "route",
      operation: "enrichment_applied",
      decision: "allowed",
      policyVersion: "connector-instance-site-inventory-intake",
      metadata: { connectorKey: CONNECTOR_KEY, ...fields },
    });
  } catch {
    /* audit is best-effort */
  }
}

/**
 * Bounded body read (contract 256 KB cap). Reads the stream chunk-by-chunk and
 * aborts the instant the cumulative byte count exceeds the cap. Deliberately
 * does NOT trust `Content-Length` to ALLOW anything — a payload-bomb sender
 * can omit it, lie about it, or use chunked transfer encoding — the header is
 * consulted only as a reject-early pre-screen (it can lie low, never high,
 * for that check), and the cap is always enforced against bytes actually
 * received. FAIL-CLOSED on shape: a request whose body exposes no stream
 * reader is refused outright rather than buffered whole — there is no
 * unbounded-buffering path through this function.
 */
async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  // Reject-only pre-screen: a DECLARED length over the cap is refused before
  // a single byte is read. Never used to allow (the chunked loop below is the
  // enforcement either way).
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false };

  let reader;
  try {
    reader = request.body?.getReader();
  } catch {
    return { ok: false };
  }
  if (!reader) return { ok: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let result;
    try {
      result = await reader.read();
    } catch {
      return { ok: false };
    }
    if (result.done) break;
    const value = result.value;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  }
  return { ok: true, text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8") };
}

export async function POST(request: Request): Promise<Response> {
  const ip = clientIp(request);

  // 1. Pre-auth rate limit — before any credential VALIDATION, body read, or
  // DB call (an unauthenticated flood never amplifies into real work). The
  // limiter charges the best-effort IP bucket AND a bucket keyed on a hash of
  // the presented credential (string ops only up to here — no validation has
  // run), so rotating the forwarded-for header under one credential is still
  // throttled. The hash means the limiter never holds a live secret.
  const authHeader = request.headers.get("Authorization");
  const credential = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const credentialKey = credential
    ? createHash("sha256").update(credential, "utf8").digest("base64url")
    : "no-credential";
  if (!allowSiteInventoryRequest({ ip, credentialKey })) {
    return rateLimited(60);
  }

  // 2. Transport auth FIRST — the body is never read for an invalid
  // credential (payload-bomb defense for the unauthenticated path).
  const requestOrigin = request.headers.get("Origin");

  const site = resolveVerifiedSiteFromCredential({
    credential,
    requestOrigin,
    expectedClient: CONNECTOR_KEY,
  });
  if (!site) {
    await auditReject("invalid_credential", { ip });
    return generic400();
  }

  // 3. Bounded-size body read (256 KB cap) — only for an authenticated sender.
  const bodyRead = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!bodyRead.ok) {
    await auditReject("payload_too_large", { ip, siteId: site.siteId });
    return generic400();
  }

  let rawBody: unknown;
  try {
    rawBody = JSON.parse(bodyRead.text);
  } catch {
    await auditReject("malformed_json", { ip, siteId: site.siteId });
    return generic400();
  }
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    await auditReject("malformed_json", { ip, siteId: site.siteId });
    return generic400();
  }
  const body = rawBody as Record<string, unknown>;

  // 4. Instance association — origin -> exactly one connector instance.
  // `claimedInstanceId` may only DISAMBIGUATE among origin-matched instances,
  // never select outside that set (enforced inside the resolver).
  const claimedInstanceId = typeof body.claimedInstanceId === "string" ? body.claimedInstanceId : null;
  const instanceId = resolveCanonicalInstanceForOrigin({
    instancesConfigKey: CONNECTOR_KEY,
    origin: site.siteOrigin,
    claimedInstanceId,
  });
  if (!instanceId) {
    await auditReject("instance_unresolved", { ip, siteId: site.siteId });
    return generic400();
  }

  // 5. Org cross-check (defense in depth) — the resolved instance's persisted
  // org binding (cinatra#274) must equal the authenticating credential's org,
  // when the instance carries one.
  const instancesConfig = readConnectorConfigFromDatabase<{ instances?: WordPressInstanceRow[] }>(
    CONNECTOR_KEY,
    { instances: [] },
  );
  const instanceRow = Array.isArray(instancesConfig?.instances)
    ? instancesConfig.instances.find((row) => row && row.id === instanceId)
    : undefined;
  const instanceOrgId = typeof instanceRow?.orgId === "string" ? instanceRow.orgId.trim() : "";
  if (instanceOrgId && instanceOrgId !== site.orgId) {
    await auditReject("org_mismatch", { ip, siteId: site.siteId, instanceId });
    return generic400();
  }

  // 6. Payload's own `client` literal cross-checked against the authenticating
  // credential's client (defense in depth; both are pinned to "wordpress"
  // today so this can never actually diverge, but the contract names the
  // cross-check explicitly).
  if (body.client !== site.client) {
    await auditReject("client_mismatch", { ip, siteId: site.siteId, instanceId });
    return generic400();
  }

  // 7. Post-auth per-site debounce (contract-required 429 + Retry-After) — run
  // before the heavier schema parse / transactional apply so a repeated call
  // within the window never reaches either. READ-ONLY here: the window is
  // recorded only after a successful COMMIT below, so a send that fails
  // version/schema/anti-replay validation never burns the site's retry slot
  // (a corrected retry goes straight through).
  const debounce = checkSiteInventoryDebounce({ siteId: site.siteId });
  if (!debounce.allowed) {
    await auditReject("debounced", { ip, siteId: site.siteId, instanceId });
    return rateLimited(debounce.retryAfterSeconds);
  }

  // 8. Contract-version gate, checked ahead of the full schema so an unknown
  // version gets the structured, supported-list-carrying response the
  // contract specifies (a newer plugin degrades LOUDLY), not a generic schema
  // failure.
  const contractVersion = typeof body.contractVersion === "string" ? body.contractVersion : undefined;
  if (
    contractVersion === undefined ||
    !(SUPPORTED_SITE_INVENTORY_VERSIONS as readonly string[]).includes(contractVersion)
  ) {
    await auditReject("unsupported_contract_version", { ip, siteId: site.siteId, instanceId });
    return NextResponse.json(
      { error: "unsupported_contract_version", supported: SUPPORTED_SITE_INVENTORY_VERSIONS },
      { status: 400 },
    );
  }

  // 9. Full payload validation (zod, STRICT — unknown fields rejected).
  const parsed = wpSiteInventoryV1Schema.safeParse(body);
  if (!parsed.success) {
    await auditReject("invalid_payload", { ip, siteId: site.siteId, instanceId });
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  const payload = parsed.data;

  // 10. Anti-replay/ordering gate + reconciler apply in ONE transaction (S3
  // round-1 atomicity fix): a failed apply rolls the accepted-sequence advance
  // back with it, so the two can never diverge under a race.
  const pool = getPooledDb({ name: "connector-instance-server" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const txQuery: ServerStoreQuery = async (text, values) => {
      const result = await client.query(text, values ? [...values] : undefined);
      return result.rows as never[];
    };

    const advanced = await tryAdvanceSiteInventory(
      {
        connectorKey: CONNECTOR_KEY,
        instanceId,
        contractVersion: payload.contractVersion,
        siteId: site.siteId,
        origin: site.siteOrigin,
        credentialVersion: site.credentialVersion,
        inventorySeq: payload.inventorySeq,
        siteMeta: payload.site,
      },
      { query: txQuery },
    );
    if (!advanced) {
      await client.query("ROLLBACK");
      await auditReject("stale_payload", { ip, siteId: site.siteId, instanceId });
      return NextResponse.json({ error: "stale_payload" }, { status: 400 });
    }

    const store: WordPressServerEnrollmentStore = {
      listInstanceServers: (connectorKey, iid) =>
        listInstanceServers(connectorKey, iid, { query: txQuery }),
      ensureDefaultServerEnrollment: (input) => ensureDefaultServerEnrollment(input, { query: txQuery }),
      upsertServer: (input) => upsertServer(input, { query: txQuery }),
      retireServer: (connectorKey, iid, sid) => retireServer(connectorKey, iid, sid, { query: txQuery }),
      deletePresentUnenrolledServer: (connectorKey, iid, sid) =>
        deletePresentUnenrolledServer(connectorKey, iid, sid, { query: txQuery }),
      deleteManualServer: (connectorKey, iid, sid) => deleteManualServer(connectorKey, iid, sid, { query: txQuery }),
      recordServerStatus: (input) => recordServerStatus(input, { query: txQuery }),
    };
    const deps: WordPressServerEnrollmentDeps = { store };

    const result = await applySiteInventory(
      {
        connectorKey: CONNECTOR_KEY,
        instanceId,
        payload,
        siteId: site.siteId,
        origin: site.siteOrigin,
      },
      deps,
    );

    await client.query("COMMIT");

    // Start the site's debounce window ONLY now that the inventory is
    // durably accepted — rejected sends above never reach this.
    markSiteInventoryAccepted({ siteId: site.siteId });

    await auditAccept({
      siteId: site.siteId,
      instanceId,
      enrolled: result.enrolled,
      presentUnenrolled: result.presentUnenrolled,
      retired: result.retired,
    });

    return NextResponse.json(
      {
        accepted: true,
        enrolled: result.enrolled,
        presentUnenrolled: result.presentUnenrolled,
        retired: result.retired,
      },
      { status: 200 },
    );
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the connection may already be broken; nothing more to do */
    }
    console.error(
      "[connect/site-inventory] apply failed:",
      err instanceof Error ? err.message : err,
    );
    await auditReject("internal_error", { ip, siteId: site.siteId, instanceId });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  } finally {
    client.release();
  }
}
