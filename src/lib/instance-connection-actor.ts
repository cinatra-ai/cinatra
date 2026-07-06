import "server-only";

// ---------------------------------------------------------------------------
// Instance-flow owner-aware gating (cinatra#967 — W2/W3 residue).
//
// The wordpress/drupal/linkedin(-mcp) instance-connector flows bypass
// `/api/nango/connections/save` (they persist their own connector_config
// instance rows and import straight into Nango), so — before this file —
// their connections never got an identity row and were never routed through
// the W2 owner-aware resolver (`enforceConnectionUse`). #952/#953 pinned them
// as `w3-residue` in the raw-reader caller-inventory ratchet specifically
// because re-routing needs (i) identity-row seeding at the instance-import
// seams and (ii) actor threading through the read call sites — this module
// is that seam + threading, shared by the four pinned files.
//
// SEED BEFORE GATE (owner ruling, cinatra#967): an instance connection
// created before the W1 backfill snapshot (or one whose owner cannot be
// resolved) may still have no identity row. Gating a connection with no
// identity row would fail closed and break a site that has worked all along
// — the exact hazard the W3 residue tracker documented. So
// `resolveOrSeedInstanceIdentity` self-heals (idempotent) at every use: read
// the identity row, and if absent, seed it now (using the instance's own
// {orgId, runBy} binding when known, else the single-tenant default
// owner/org) before gating. When NO owner can be resolved at all, the
// identity stays unseeded and the caller falls back to the pre-existing
// ungated read — never a new regression on top of the pre-#967 behavior.
//
// LAZY IMPORTS (same rationale as `github-api.ts`/`external-mcp-registry.ts`):
// this module is imported at the TOP of every wordpress/drupal/linkedin
// vendor file, which in turn are imported by many callers that never touch a
// live connection (settings pages, dev-auto-setup, unit tests). Dynamically
// importing the identity-store/use-gate/content-editor-run-identity graph
// keeps that boot cost — and the DB/auth module graph — out of callers that
// never resolve/gate a connection.
// ---------------------------------------------------------------------------

import type { ActorContext } from "@/lib/authz";
import { POLICY_VERSION } from "@/lib/authz/actor-context";
import type { NangoConnectionIdentity } from "@cinatra-ai/extensions/connection-identity-store";

/** The per-instance {orgId, runBy} multi-tenant binding (cinatra#274),
 * persisted on the wordpress/drupal instance row at save time. LinkedIn
 * carries no such binding yet — callers simply omit it and the single-tenant
 * default resolves ownership instead. */
export type InstanceOwnerBinding = { orgId?: string; runBy?: string };

function completeBinding(
  binding: InstanceOwnerBinding | undefined,
): { orgId: string; runBy: string } | undefined {
  const orgId = binding?.orgId?.trim();
  const runBy = binding?.runBy?.trim();
  return orgId && runBy ? { orgId, runBy } : undefined;
}

/**
 * Idempotently resolve the identity row for an instance-flow connection,
 * seeding it (self-heal) when absent and an owner can be resolved. Returns
 * `null` only when no identity row exists AND none could be seeded — the
 * caller then skips gating entirely (pre-#967 ungated behavior, unchanged).
 *
 * Seeds with the `"workspace"` grant (org-shared BY CONSTRUCTION), mirroring
 * `core__0015`'s Phase A legacy-`scope:"app"` seed and the external-MCP
 * instance-global seed: these wordpress/drupal/(org-)linkedin connections are
 * INSTALL-level, single-tenant-org credentials — not personal per-user
 * connections — so the connecting admin's org can genuinely use them, not
 * just the resolved owner. This is load-bearing for `buildInstanceActor`
 * below: an InternalWorker with no live actor is authorized by the REAL
 * workspace-visibility grant, never by a fabricated ownership claim (codex
 * round-0 finding).
 *
 * A foreign-row conflict (or an unresolvable connector→package mapping)
 * FAILS CLOSED (propagates) — it is a genuine anomaly, not "not yet seeded";
 * silently falling back to the ungated legacy path here would let a
 * cross-tenant identity conflict slip through unaudited (codex round-0
 * finding).
 */
export async function resolveOrSeedInstanceIdentity(input: {
  connectorKey: string;
  connectionId: string;
  binding?: InstanceOwnerBinding;
}): Promise<NangoConnectionIdentity | null> {
  const { connectorKey, connectionId, binding } = input;
  const { readNangoConnectionByNaturalKey } = await import(
    "@cinatra-ai/extensions/connection-identity-store"
  );
  const existing = await readNangoConnectionByNaturalKey(connectorKey, connectionId);
  if (existing) return existing;

  const { resolveSingleTenantContentEditorIdentity } = await import(
    "@/lib/content-editor-run-identity"
  );
  const owner = completeBinding(binding) ?? (await resolveSingleTenantContentEditorIdentity());
  if (!owner) return null;

  const { registerSavedConnectionIdentity } = await import("@/lib/connection-identity-seam");
  return registerSavedConnectionIdentity({
    connectorKey,
    connectionId,
    ownerUserId: owner.runBy,
    organizationId: owner.orgId,
    seed: "workspace",
  });
}

/**
 * Build the ActorContext for an instance-flow credential use:
 *   • the configuring admin (HumanUser) when the resolved binding's `runBy`
 *     IS the identity's recorded owner — an honest first-party actor, never
 *     fabricated for someone else's row;
 *   • otherwise an InternalWorker bound to the identity's ORG only (mirrors
 *     the youtube-api scraper-mint pattern EXACTLY — no `runAsUserId`). A
 *     worker with `runAsUserId: identity.ownerUserId` would trip the gate's
 *     OWN short-circuit and self-authorize against ANY existing identity
 *     row regardless of whether a trusted binding/session actually named
 *     that owner — a tautology, not authorization (codex round-0 finding).
 *     The org-bound worker is instead authorized by the REAL workspace grant
 *     `resolveOrSeedInstanceIdentity` seeds (or the pre-existing
 *     `core__0015` legacy grant for rows seeded before #967).
 */
export function buildInstanceActor(input: {
  identity: NangoConnectionIdentity;
  binding?: InstanceOwnerBinding;
  source: string;
}): ActorContext {
  const { identity, binding, source } = input;
  const owner = completeBinding(binding);
  if (owner && owner.runBy === identity.ownerUserId) {
    return {
      principalType: "HumanUser",
      principalId: owner.runBy,
      organizationId: identity.organizationId ?? owner.orgId,
      authSource: "worker",
      policyVersion: POLICY_VERSION,
    };
  }
  return {
    principalType: "InternalWorker",
    principalId: `worker:${source}`,
    organizationId: identity.organizationId ?? undefined,
    authSource: "worker",
    policyVersion: POLICY_VERSION,
  };
}

/**
 * Resolve-or-seed the identity, then gate + audit the use through the W2
 * `enforceConnectionUse` seam (allow AND deny are both audited; deny is
 * awaited before any throw — same invariant as every other gated caller).
 * Returns `null` when no identity could be resolved/seeded — the caller
 * falls back to the pre-#967 ungated read (never a regression).
 */
export async function enforceInstanceConnectionUse(input: {
  connectorKey: string;
  connectionId: string;
  binding?: InstanceOwnerBinding;
  source: string;
  runId?: string;
}): Promise<NangoConnectionIdentity | null> {
  const identity = await resolveOrSeedInstanceIdentity(input);
  if (!identity) return null;
  const actor = buildInstanceActor({ identity, binding: input.binding, source: input.source });
  const { enforceConnectionUse, connectionSubjectUserId } = await import(
    "@/lib/connection-use-gate"
  );
  await enforceConnectionUse({
    identity,
    actor,
    subjectUserId: connectionSubjectUserId(actor),
    runId: input.runId,
    source: input.source,
  });
  return identity;
}

// ---------------------------------------------------------------------------
// Per-USER (org-less) instance connections — e.g. LinkedIn's `scope:"user"`
// personal profile connections, addressed by an actual live `userId` rather
// than a resolved tenant {orgId, runBy} binding. Strictly per-actor: seeded
// with a NULL organization (mirrors the `only:"user"` class documented on
// `packages/google-oauth-connection/src/index.ts`'s own w3-residue pin), and
// the acting HumanUser IS the identity owner by construction (freshly seeded
// with that exact ownerUserId, or previously seeded the same way).
// ---------------------------------------------------------------------------

export async function resolveOrSeedPerUserInstanceIdentity(input: {
  connectorKey: string;
  connectionId: string;
  userId: string;
}): Promise<NangoConnectionIdentity | null> {
  const { connectorKey, connectionId, userId } = input;
  const { readNangoConnectionByNaturalKey } = await import(
    "@cinatra-ai/extensions/connection-identity-store"
  );
  const existing = await readNangoConnectionByNaturalKey(connectorKey, connectionId);
  if (existing) return existing;

  // A foreign-row conflict FAILS CLOSED (propagates) — see the parallel note
  // on `resolveOrSeedInstanceIdentity` above (codex round-0 finding).
  const { registerSavedConnectionIdentity } = await import("@/lib/connection-identity-seam");
  return registerSavedConnectionIdentity({
    connectorKey,
    connectionId,
    ownerUserId: userId,
    organizationId: null,
  });
}

export async function enforcePerUserInstanceConnectionUse(input: {
  connectorKey: string;
  connectionId: string;
  userId: string;
  source: string;
  runId?: string;
}): Promise<NangoConnectionIdentity | null> {
  const identity = await resolveOrSeedPerUserInstanceIdentity(input);
  if (!identity) return null;
  const actor: ActorContext = {
    principalType: "HumanUser",
    principalId: input.userId,
    organizationId: identity.organizationId ?? undefined,
    authSource: "worker",
    policyVersion: POLICY_VERSION,
  };
  const { enforceConnectionUse, connectionSubjectUserId } = await import(
    "@/lib/connection-use-gate"
  );
  await enforceConnectionUse({
    identity,
    actor,
    subjectUserId: connectionSubjectUserId(actor),
    runId: input.runId,
    source: input.source,
  });
  return identity;
}

/**
 * Cross-boundary deny classifier (#975 Wave 3 / epic #978): `true` iff `err`
 * is the host use-gate's `ConnectionUseDeniedError`. STRUCTURAL (checks the
 * class's `connectionUseDenied` marker field) rather than `instanceof`, so
 * this stays SYNCHRONOUS with no static import of the use-gate module — this
 * seam deliberately keeps the DB/auth module graph out of its load path (see
 * the LAZY IMPORTS note above), and the classifier is published to extensions
 * as the `@cinatra-ai/host:instance-connection-gate` service's
 * `isConnectionUseDenied` member (extensions cannot import the error class).
 * Keep in sync with the marker on `ConnectionUseDeniedError`
 * (`@/lib/connection-use-gate`).
 */
export function isConnectionUseDeniedError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as { connectionUseDenied?: unknown }).connectionUseDenied === true
  );
}

/**
 * The actor-less in-process WORKER gate (#975 Wave 3 / epic #978): the
 * youtube-api scraper-mint pattern generalized for any relocated vendor
 * client whose consumer is an in-process host service with no live actor.
 *
 * NO seeding (unlike `enforceInstanceConnectionUse`): a connection with no
 * identity row FAILS CLOSED to `false` — the actor-less global reader must
 * never self-heal an ownership claim it cannot ground. A use-gate DENY also
 * folds to `false` (the deny audit row is durably written by the gate before
 * it throws); any OTHER error propagates fail-loud. Returns a BARE boolean —
 * a result record would be truthy even when unauthorized, so `if (await …)`
 * would misread a deny (codex round-0 finding). The `InternalWorker` actor
 * is bound to the identity row's ORGANIZATION only (never a fabricated human
 * / `runAsUserId` — see the `buildInstanceActor` note), so the cross-org
 * guard and workspace grants evaluate correctly.
 */
export async function authorizeWorkerConnectionUse(input: {
  connectorKey: string;
  connectionId: string;
  source: string;
  runId?: string;
}): Promise<boolean> {
  const { readNangoConnectionByNaturalKey } = await import(
    "@cinatra-ai/extensions/connection-identity-store"
  );
  const identity = await readNangoConnectionByNaturalKey(input.connectorKey, input.connectionId);
  if (!identity) return false;
  const actor: ActorContext = {
    principalType: "InternalWorker",
    principalId: `worker:${input.source}`,
    organizationId: identity.organizationId ?? undefined,
    authSource: "worker",
    policyVersion: POLICY_VERSION,
  };
  const { enforceConnectionUse } = await import("@/lib/connection-use-gate");
  try {
    await enforceConnectionUse({
      identity,
      actor,
      subjectUserId: undefined,
      runId: input.runId,
      source: input.source,
    });
  } catch (err) {
    if (isConnectionUseDeniedError(err)) return false;
    throw err;
  }
  return true;
}

/**
 * The TRUSTED save-time `{orgId, runBy}` binding source (#975 Wave 3 / epic
 * #978, codex round-0 finding): resolves the CURRENT request's validated
 * admin session to the install→org binding persisted on instance rows
 * (cinatra#274). This mirrors drupal-api's private
 * `resolveActorBindingFromSession` EXACTLY — the host session is the only
 * sanctioned origin for a FRESH binding (the identity seam's "validated
 * session, never request input" rule), so the relocated vendor clients
 * resolve it here instead of importing `@/lib/auth-session`.
 *
 * - Returns `null` unless BOTH the active organization id and the user id
 *   resolve — never half a binding.
 * - NEVER throws or redirects: a session-less call path (local-dev /
 *   dev-auto-setup, or a request with no cookies) simply yields `null`, so
 *   the row keeps whatever binding it already had and the resolver falls
 *   back to single-tenant identity. Read-only — it gates nothing (the
 *   caller's `requireExtensionAction("manage")` already did).
 * - Lazy-imports `@/lib/auth-session` (see the LAZY IMPORTS note above).
 */
export async function resolveTrustedSessionBinding(): Promise<
  { orgId: string; runBy: string } | null
> {
  try {
    const { getAuthSession } = await import("@/lib/auth-session");
    const session = await getAuthSession();
    const orgId = session?.session?.activeOrganizationId?.trim() || "";
    const runBy = session?.user?.id?.trim() || "";
    if (!orgId || !runBy) return null;
    return { orgId, runBy };
  } catch {
    // No request context / headers unavailable / no session — the caller
    // keeps the existing binding and single-tenant fallback semantics.
    return null;
  }
}
