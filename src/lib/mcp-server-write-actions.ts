import "server-only";

// HOST-side binding of the EXTERNAL-MCP-REGISTRY write actions for a
// schema-config connector's setup surface (cinatra#658, PR-4).
//
// A schema-config connector that carries the host external-MCP registry surface
// registers ONLY the READ/PROBE named actions (`listServers`,
// `connectionServiceReady`) in its own `register(ctx)` — it deliberately DEFERS
// the WRITE actions (`createServer` / `deleteServer`) + their per-operation
// authorization to the HOST (the connector never evaluates the actor). This module
// binds those two write actions into the SAME host ui-action registry the read
// actions land in, so the single host action endpoint
// `/api/extensions/{installId}/actions/{actionId}` dispatches all four uniformly.
//
// INSTANCE-COUPLING: this module names NO extension package. It DISCOVERS the
// target package from the generated `STATIC_EXTENSION_MANIFEST` (the sanctioned,
// gate-exempt manifest tree) by matching the connector whose declared
// `configSchema` references BOTH the `createServer` and `deleteServer` action ids
// — the same "route through the manifest, never name a specific extension" pattern
// `register-host-connector-services.ts` uses for the capability surface. The write
// LOGIC binds the host-owned external-MCP registry (a host concern), not the
// connector.
//
// SECURITY (invariant 3 — setup/write actions stay HOST-authorized):
//  - The action endpoint already authorized the actor at the `use` tier
//    (`canExtensionAccess(..., "use")`) BEFORE the handler runs.
//  - These handlers add the PER-OPERATION authorization the existing host
//    `createExternalMcpServerAction` / `deleteExternalMcpServerAction` server
//    actions enforce — re-derived HOST-side from the trusted session, NEVER from
//    connector/package input:
//      * a `global` write/delete requires PLATFORM ADMIN (a global external-MCP row
//        is injected into every LLM call's toolbox — a platform-wide trust
//        mutation);
//      * a `user`-scoped write/delete requires only an authenticated actor and is
//        bound to / gated on that actor's own userId;
//      * an existing row is re-read by id and its EXISTING scope/owner re-checked
//        before any overwrite/delete (the upsert is ON CONFLICT DO UPDATE).
//  - Per codex finding 2: the `external_mcp_servers` store has only `org_id` /
//    `user_id` columns (no team column), and an org-bound row maps to ORG-WIDE
//    visibility — so an `org` / `team` / `workspace` scope cannot be stored
//    SAFELY without overexposing. The handler therefore REJECTS those scopes
//    fail-closed (the schema still DECLARES them as admin-only options for a
//    future migration; the host refuses to persist what it cannot scope safely).
//
// The handlers return JSON `{ banner: "saved" | "deleted" }` (not a redirect) so
// the declarative renderer's `banner` field reacts; on any authz/validation
// failure they THROW (the dispatch maps a thrown handler to a 4xx/5xx + `{ error }`).

import { registerExtensionUiAction } from "@/lib/extension-ui-registry";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";
import {
  normalizeExternalMcpTransport,
  type ExternalMcpServerScope,
} from "@/lib/external-mcp-registry";

/** The write-action ids the host binds for the external-MCP registry surface. */
const CREATE_ACTION_ID = "createServer";
const DELETE_ACTION_ID = "deleteServer";

/**
 * Discover the package(s) whose declared `configSchema` references BOTH host
 * write actions, from the generated manifest (the gate-exempt sanctioned source —
 * core never names a specific extension). Returns every matching package name so
 * a rename/refork of the connector keeps working without a core edit.
 */
function discoverExternalMcpWritePackages(): string[] {
  const out: string[] = [];
  for (const [packageName, entry] of Object.entries(STATIC_EXTENSION_MANIFEST)) {
    const configSchema = (entry as { configSchema?: unknown } | undefined)?.configSchema;
    if (!configSchema || typeof configSchema !== "object") continue;
    const fields = (configSchema as { fields?: unknown }).fields;
    if (!Array.isArray(fields)) continue;
    const actionIds = new Set<string>();
    for (const f of fields) {
      if (!f || typeof f !== "object") continue;
      const rec = f as Record<string, unknown>;
      for (const key of ["actionId", "listActionId", "deleteActionId", "probeActionId"]) {
        const v = rec[key];
        if (typeof v === "string") actionIds.add(v);
      }
    }
    if (actionIds.has(CREATE_ACTION_ID) && actionIds.has(DELETE_ACTION_ID)) {
      out.push(packageName);
    }
  }
  return out;
}

/** Scopes the `external_mcp_servers` store can persist + scope SAFELY today. */
const STORABLE_SCOPES = new Set(["global", "user"]);

class WriteActionError extends Error {}

// The trusted session shape the authz checks read: the user id (for own-row
// ownership) and the role (for `isPlatformAdmin`). `requireAuthSession` returns
// the full Better Auth session, which carries both.
type SessionLike = {
  user: { id: string; role?: string | null };
  // The active org (Better Auth session) — the connection identity's org binding
  // (cinatra#1407 defect 1), read exactly as the Twenty connect flow reads it.
  session?: { activeOrganizationId?: string | null } | null;
};

/** Resolve the trusted session host-side (never from package input). */
async function requireSession(): Promise<SessionLike> {
  const { requireAuthSession } = await import("@/lib/auth-session");
  return requireAuthSession();
}

async function isPlatformAdminNow(session: SessionLike): Promise<boolean> {
  const { isPlatformAdmin } = await import("@/lib/auth-session");
  return isPlatformAdmin(session);
}

function asString(input: unknown, key: string): string | undefined {
  if (input && typeof input === "object") {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/**
 * createServer({ label, serverUrl, apiKey?, scope }) — register/upsert an
 * external MCP server. Mirrors `createExternalMcpServerAction` authz exactly, as
 * JSON. Returns `{ banner: "saved" }` or throws.
 *
 * Exported for direct authz testing; production reaches it via the registered
 * named action through the host action endpoint.
 */
export async function createServerHandler(input: unknown): Promise<{ banner: "saved" }> {
  const label = asString(input, "label")?.trim();
  const serverUrl = asString(input, "serverUrl")?.trim();
  const requestedScope = asString(input, "scope") ?? "user";
  const requestedId = asString(input, "id")?.trim() || undefined;
  // llm-providers S2 (#1713): the connector setup form may post a transport;
  // coerce it to the closed vocabulary (omitted / unrecognized => "unknown").
  // Never inferred from serverUrl.
  const transport = normalizeExternalMcpTransport(asString(input, "transport"));
  // The optional API key the connector's `secret` field posts (cinatra#1407
  // defect 1). Blank/whitespace is treated as "no key" — the row's connection is
  // left null (apiKeyConfigured stays false) rather than storing an empty secret.
  const apiKey = asString(input, "apiKey")?.trim() || undefined;

  if (!label) throw new WriteActionError("A label is required.");
  if (!serverUrl) throw new WriteActionError("A server URL is required.");
  // Fail-closed on a scope the store cannot represent safely (codex finding 2).
  if (!STORABLE_SCOPES.has(requestedScope)) {
    throw new WriteActionError(
      `Scope "${requestedScope}" is not yet supported — choose Global (admins) or Personal.`,
    );
  }
  const scope: "global" | "user" = requestedScope === "global" ? "global" : "user";

  const session = await requireSession();
  const {
    getExternalMcpServerByIdFresh,
    insertExternalMcpServerStrict,
    updateExternalMcpServerGuarded,
    importExternalMcpApiKeyConnection,
    revokeExternalMcpApiKeyConnection,
    ExternalMcpServerWriteConflictError,
    ExternalMcpServerManagedEndpointError,
  } = await import("@/lib/external-mcp-registry");
  // cinatra#3485: the keyless connection identity follows the row, and every
  // write road reconciles it through the ONE lifecycle, never a copy.
  const {
    reconcileKeylessConnectionIdentityAfterSave,
    keylessIdentityCollisionAtCreate,
    keylessIdentityCollisionMessage,
  } = await import("@/lib/external-mcp-keyless-identity");

  // A global write is a platform-wide trust mutation → PLATFORM ADMIN required.
  // A user write only needs an authenticated actor (already proven by the endpoint).
  const actorIsAdmin = await isPlatformAdminNow(session);
  if (scope === "global" && !actorIsAdmin) {
    throw new WriteActionError("Only a platform admin can register a global MCP server.");
  }

  // ID-overwrite guard: re-derive the authority from the EXISTING row, not just
  // the requested scope, so a supplied id cannot overwrite a global / foreign /
  // org-scoped row. `preservedUserId` keeps the EXISTING owner of a user row so an
  // admin edit never silently reassigns ownership to the admin (codex final-r1
  // finding 1: a `scope:"user"` overwrite must not steal the row).
  //
  // TOCTOU hardening (Refs cinatra#658): the authorization read is FRESH
  // (`getExternalMcpServerByIdFresh` — bypasses the 30s TTL cache that
  // `getExternalMcpServerById` serves from, which could otherwise hand back a row
  // whose scope/owner changed on another worker), and the write is CONDITIONAL on
  // the row STILL matching the witnessed scope+owner
  // (`updateExternalMcpServerGuarded` for an existing row;
  // `insertExternalMcpServerStrict` for a new id, which never clobbers a
  // concurrently-created row). A race that flips the row under the actor surfaces
  // as a conflict → mapped to a fail-closed denial below.
  let preservedUserId: string | null | undefined;
  // Preserve an EXISTING row's stored connection on an edit that supplies no new
  // key, so a label/URL-only update never silently drops a previously-stored API
  // key (cinatra#1407 defect 1). Captured for an existing row of ANY scope.
  let preservedNangoConnectionId: string | null | undefined;
  let guard:
    | { scope: ExternalMcpServerScope; userId: string | null; nangoConnectionId?: string | null }
    | undefined;
  if (requestedId) {
    const existing = getExternalMcpServerByIdFresh(requestedId);
    if (existing) {
      preservedNangoConnectionId = existing.nangoConnectionId;
      if (existing.scope === "global") {
        if (!actorIsAdmin) {
          throw new WriteActionError("Only a platform admin can modify a global MCP server.");
        }
      } else if (existing.scope === "user") {
        const actorOwnsRow = existing.userId !== null && existing.userId === session.user.id;
        if (!actorIsAdmin && !actorOwnsRow) {
          throw new WriteActionError("You can only modify your own MCP servers.");
        }
        if (scope === "global" && !actorIsAdmin) {
          throw new WriteActionError("Only a platform admin can promote a server to global.");
        }
        // Preserve the existing owner unless the row is being promoted to global
        // (no owner). An admin editing someone else's user row keeps THEIR owner.
        if (scope === "user") preservedUserId = existing.userId;
      } else {
        // An existing org / team / workspace row is a scope this module cannot
        // safely reason about (codex final-r1 finding 2) — require platform admin
        // to touch it at all, and never let a write here re-scope/reassign it.
        if (!actorIsAdmin) {
          throw new WriteActionError(
            "Only a platform admin can modify this server (organization/team-scoped).",
          );
        }
      }
      // The compare-and-write guard is the WITNESSED existing scope+owner AND its
      // current connection (cinatra#1407): a concurrent re-key/keyless-edit that
      // moved the connection between this fresh read and the write fails closed
      // instead of resurrecting a revoked pointer or landing a row that advertises
      // an unmintable key.
      guard = {
        scope: existing.scope,
        userId: existing.userId,
        nangoConnectionId: existing.nangoConnectionId,
      };
    }
  }

  const { randomUUID } = await import("node:crypto");
  const id = requestedId || randomUUID();

  // Persist the API key through the SANCTIONED connection-service path
  // (cinatra#1407 defect 1), mirroring the Twenty connect flow's credential +
  // identity seam. When a key is supplied: import it into Nango (readback-verified)
  // under a UNIQUE per-write connection id, then register the `externalMcp`
  // connection IDENTITY (folded into the helper) — without that identity the
  // use-gate fails closed and `resolveExternalMcpServerBearer` mints NO bearer, so
  // the stored key would never authenticate and `apiKeyConfigured` would be a lie.
  // A UNIQUE connection id per write means a rejected write never overwrites or
  // cross-wires a credential another row still references. When NO key is supplied
  // on an edit, PRESERVE the existing connection (never drop a stored key on a
  // label/URL-only edit); a new keyless row stays null. Fail-closed: a key that
  // cannot be fully persisted rolls back and THROWS (the row write never runs), so
  // no row ever advertises a key it cannot mint. The key is never logged/echoed —
  // the helpers own the taint-not-access boundary (vault + readback failures throw
  // a GENERIC message carrying no key value).
  const organizationId = session.session?.activeOrganizationId ?? null;
  // A user row's credential is owned by the row's owner (preserved on an admin
  // edit of someone else's row); a global row's is owned by the registering
  // admin.
  const credentialOwnerUserId =
    scope === "user" ? preservedUserId ?? session.user.id : session.user.id;
  // The ORGANIZATION stored on the connection identity (cinatra#3397). A user
  // row the signed-in person registers for THEMSELVES carries THAT person's own
  // organization, read from the session — a person who belongs to none still
  // creates the connection, without one. Without this the identity was always
  // null-org, and the Sharing tab's `workspace` share was refused at write time
  // by the ratified veto (a workspace locus on a null-org identity row is
  // `invalid_locus` — that rule stands unchanged).
  //
  // An admin editing ANOTHER user's row keeps that row's credential org-less:
  // it is not the admin's connection and must never be re-homed to the acting
  // admin's organization (cross-org safety). A global row's credential stays
  // owned by the registering admin and workspace-seeded (org-shared) so the
  // org-bound InternalWorker use-gate can mint it — an owner-only grant would
  // deny that mint.
  //
  // DERIVED ONCE FOR BOTH ROADS (cinatra#3485): the keyless registration after
  // the row write registers the SAME identity — the same owner, the same
  // organization, the same seed — that the keyed road registers here, so which
  // road a server took never changes whose connection it is or where it shares.
  const selfRegistered = credentialOwnerUserId === session.user.id;
  const identityOrganizationId =
    scope === "user" ? (selfRegistered ? organizationId : null) : organizationId;
  const identitySeed: "owner" | "workspace" = scope === "user" ? "owner" : "workspace";

  // IS THE SUPPLIED ID FREE? (cinatra#3485 fix leg 4, the seventh round.) A
  // create at an id another person's live identity still holds used to be
  // reported as saved while the panel stayed with that person, and no save of
  // the new row could repair it. It is refused here, BEFORE the key import and
  // before the row write, so nothing lands at all. Only a create asks: an
  // existing row is an update, and the save road reconciles its identity on its
  // own terms. A newly minted id can collide with nothing.
  if (requestedId && !guard) {
    const collision = await keylessIdentityCollisionAtCreate({
      serverId: id,
      identityOwnerUserId: credentialOwnerUserId,
    });
    if (collision) throw new WriteActionError(keylessIdentityCollisionMessage(id));
  }

  let nangoConnectionId: string | null = preservedNangoConnectionId ?? null;
  let newConnectionId: string | undefined;
  if (apiKey) {
    newConnectionId = `external-mcp-${randomUUID()}`;
    try {
      await importExternalMcpApiKeyConnection(newConnectionId, apiKey, {
        ownerUserId: credentialOwnerUserId,
        organizationId: identityOrganizationId,
        seed: identitySeed,
      });
    } catch (err) {
      // Roll back any partial credential/identity so a failed persist leaves
      // nothing behind, then surface a non-secret message (the helpers never echo
      // the key — every failure message is generic or field-level).
      await revokeExternalMcpApiKeyConnection(newConnectionId);
      throw err instanceof WriteActionError
        ? err
        : new WriteActionError(
            err instanceof Error && err.message
              ? err.message
              : "Could not store the API key — please try again.",
          );
    }
    nangoConnectionId = newConnectionId;
  }

  const row = {
    id,
    label,
    serverUrl,
    scope,
    nangoConnectionId,
    orgId: null,
    // For a user-scoped write: preserve the existing owner on an overwrite
    // (never steal it), else bind to the creating actor. Global rows have no owner.
    userId: scope === "user" ? preservedUserId ?? session.user.id : null,
    enabled: true,
    // Persist the declared transport, or "unknown" when omitted (#1713).
    transport,
  };
  // THE STAMPS OF THE ROW THIS SAVE WROTE (cinatra#3485). The write returns the
  // row's creation instant and the update instant it stamped, which is the only
  // thing that tells this row apart from a replacement somebody creates at the
  // same id: ids are supplied by the caller, and a delete followed by a fresh
  // registration lands a row with the same scope, the same owner and no key.
  let written: { createdAt: string | null; updatedAt: string | null } | null = null;
  try {
    if (guard) {
      // Existing row: conditional UPDATE guarded on the witnessed scope+owner.
      written = updateExternalMcpServerGuarded(row, guard);
    } else {
      // New row (no existing row at the fresh read): strict INSERT that refuses
      // to clobber a concurrently-created id.
      written = insertExternalMcpServerStrict(row);
    }
  } catch (err) {
    // The row write did NOT land — roll back the just-created credential+identity
    // so no orphaned/foreign credential survives a rejected write (fail-closed).
    if (newConnectionId) await revokeExternalMcpApiKeyConnection(newConnectionId);
    if (err instanceof ExternalMcpServerWriteConflictError) {
      // The row changed under the authorized operation (TOCTOU race) → deny.
      throw new WriteActionError(
        "This MCP server changed while saving — re-check its scope and try again.",
      );
    }
    if (err instanceof ExternalMcpServerManagedEndpointError) {
      // Managed/BYO containment (cinatra#2015 S0): the endpoint belongs to a
      // connected site's connector instance.
      throw new WriteActionError(err.message);
    }
    throw err;
  }
  // The write landed under the NEW connection: best-effort revoke the PRIOR one it
  // replaced (a re-key), so a stale credential never outlives its row pointer.
  if (
    newConnectionId &&
    preservedNangoConnectionId &&
    preservedNangoConnectionId !== newConnectionId
  ) {
    await revokeExternalMcpApiKeyConnection(preservedNangoConnectionId);
  }
  // cinatra#3485: the row has landed, so its keyless connection identity is
  // reconciled against what it landed as. The whole reading lives in the one
  // lifecycle, which every write road on these rows travels: whether an identity
  // may stand for this row at all, whether this save wrote the row that stands
  // there now, whose identity this save may retire, and what it takes back when
  // it loses the row. Best-effort by contract: a saved server never becomes an
  // error because its panel could not be written.
  await reconcileKeylessConnectionIdentityAfterSave({
    serverId: id,
    row: { scope: row.scope, userId: row.userId },
    guard,
    written,
    storedCredential: nangoConnectionId,
    identity: {
      ownerUserId: credentialOwnerUserId,
      organizationId: identityOrganizationId,
      seed: identitySeed,
    },
    actorIsAdmin,
  });
  return { banner: "saved" };
}

/**
 * deleteServer({ id }) — remove an external MCP server. Mirrors
 * `deleteExternalMcpServerAction` authz exactly. Returns `{ banner: "deleted" }`
 * or throws. Exported for direct authz testing.
 */
export async function deleteServerHandler(input: unknown): Promise<{ banner: "deleted" }> {
  const id = asString(input, "id")?.trim();
  if (!id) throw new WriteActionError("A server id is required.");

  const session = await requireSession();
  // TOCTOU hardening (Refs cinatra#658): authorize against a FRESH read (not the
  // 30s TTL cache) and delete CONDITIONALLY on the witnessed scope+owner so a row
  // promoted/re-owned between read and delete fails closed instead of being
  // deleted under the actor's stale view.
  const { getExternalMcpServerByIdFresh, ExternalMcpServerWriteConflictError } = await import(
    "@/lib/external-mcp-registry"
  );
  // The same ONE lifecycle the save roads reconcile through (cinatra#3485).
  const { deleteExternalMcpServerRowWithIdentities, reconcileOrphanKeylessConnectionIdentity } =
    await import("@/lib/external-mcp-keyless-identity");
  const server = getExternalMcpServerByIdFresh(id);
  if (!server) {
    // Already gone: idempotent success (the row is not there to over-expose).
    // RECONCILE AN ORPHAN FIRST: the identity of a row an earlier delete removed
    // while its own retire failed. The lifecycle owns who may take it away.
    await reconcileOrphanKeylessConnectionIdentity({
      serverId: id,
      actorUserId: session.user.id,
      actorIsAdmin: await isPlatformAdminNow(session),
    });
    return { banner: "deleted" };
  }
  const actorIsAdmin = await isPlatformAdminNow(session);
  if (server.scope === "user") {
    // A user row: owner or admin only.
    const actorOwnsRow = server.userId !== null && server.userId === session.user.id;
    if (!actorIsAdmin && !actorOwnsRow) {
      throw new WriteActionError("You can only delete your own MCP servers.");
    }
  } else {
    // global / org / team / workspace — a shared row → PLATFORM ADMIN only
    // (codex final-r1 finding 2: a non-user scope is never an actor-owned row).
    if (!actorIsAdmin) {
      throw new WriteActionError("Only a platform admin can delete this MCP server.");
    }
  }
  // THE ONE DELETE STEP (cinatra#3485 fix leg 4): revoke the stored credential,
  // delete the row under a guard that witnesses its connection, retire the
  // derived keyless identity after the row is gone. The lifecycle owns that
  // order and the reasons for it, and the host server actions travel the very
  // same step rather than a second copy of it.
  try {
    await deleteExternalMcpServerRowWithIdentities({
      serverId: id,
      row: {
        scope: server.scope,
        userId: server.userId,
        nangoConnectionId: server.nangoConnectionId,
      },
      actorUserId: session.user.id,
      actorIsAdmin,
    });
  } catch (err) {
    if (err instanceof ExternalMcpServerWriteConflictError) {
      // The row changed/vanished under the authorized delete (TOCTOU race) → deny.
      throw new WriteActionError(
        "This MCP server changed while deleting — re-check its scope and try again.",
      );
    }
    throw err;
  }
  return { banner: "deleted" };
}

/**
 * Register the host-owned write actions into the ui-action registry for the
 * discovered external-MCP-registry connector package(s). Idempotent — registering
 * an action id REPLACES (Map.set) rather than appends, so re-running is harmless
 * (and re-installs the binding if a test or teardown cleared the registry). Called
 * at host boot (the action endpoint imports `@/lib/extensions`, which imports
 * this). The connector's own `register(ctx)` registers the read/probe actions into
 * the same per-package registry entry; these two write actions complete the
 * four-action contract.
 */
export function registerMcpServerWriteActions(): void {
  // Bind the host write actions for EVERY package the manifest shows declaring
  // both write action ids (normally exactly one — the external-MCP connector).
  // Core names no extension: the package set comes from the generated manifest.
  const packages = discoverExternalMcpWritePackages();
  // codex-r2 hardening: the external-MCP write surface is meant for exactly ONE
  // connector. If a second trusted in-repo extension ever declares both ids, it
  // would also receive these external-MCP handlers — warn so the ambiguity is
  // caught at build/boot rather than silently widening the surface. (This is a
  // build-time-only diagnostic; the handlers themselves stay fully host-authorized
  // and the dispatch still anchors to each package's own live install row.)
  if (packages.length > 1) {
    console.warn(
      "[mcp-server-write-actions] more than one manifest package declares the " +
        `external-MCP write actions (${packages.join(", ")}); binding the host ` +
        "handlers to all of them — confirm this is intended.",
    );
  }
  for (const packageName of packages) {
    registerExtensionUiAction({
      packageName,
      id: CREATE_ACTION_ID,
      handler: (input) => createServerHandler(input),
    });
    registerExtensionUiAction({
      packageName,
      id: DELETE_ACTION_ID,
      handler: (input) => deleteServerHandler(input),
    });
  }
}

// Auto-register on import (a side-effect import from `@/lib/extensions`).
registerMcpServerWriteActions();
