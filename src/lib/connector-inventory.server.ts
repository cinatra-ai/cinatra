import "server-only";

// ---------------------------------------------------------------------------
// Connector inventory (cinatra#2723) — the READ-ONLY answer to "which
// connectors are live in this workspace?", built for a POSSIBLY-INJECTED chat
// LLM rather than for a page.
//
// WHY A SEPARATE MODULE FROM THE PAGE. `/connectors` reads
// `listNangoConnectionsForScopeFilter(activeOrgId, actorUserId)` and folds the
// rows into aggregate scope-filter math. That reader is NOT an actor-authorized
// inventory: for an active org it returns EVERY live row of the org plus the
// actor's own rows (see `listNangoConnectionsForScopeFilter`). Aggregating them
// is fine; SERIALIZING them into a conversation would hand the model foreign,
// owner-only connections. So every row here passes the per-connection `use`
// authorization gate (`decideConnectionUse`) before anything about it is
// emitted, and the projector below is the ONLY place a result row is built.
//
// THE AUTHORIZATION BOUNDARY IS PER-ROW AUTHORIZATION, NOT ID SECRECY. Hiding
// ids would buy nothing: the invoker re-authorizes every call live, and the
// assistants directory already returns authorized instance ids by design. So
// the safe shape returns the POST-AUTHORIZATION connection ids and excludes
// credentials, tokens, secret refs, and the raw Nango connection identifier.
//
// THE RESULT SHAPE IS THE NARROW, DOCUMENTED CATALOG SHAPE — deliberately NOT
// a page-equivalent. `/connectors` derives its cards from connection policies,
// installed-extension state, actor visibility, runtime-only connector trust
// resolution, extension manifests, and per-connector readiness probes. This
// tool answers a smaller question with a stable contract:
//
//     connector key + display name + authorized-connection presence
//     (+ the authorized connection ids behind that presence)
//
// EXPLICIT EXCLUSIONS of the narrow shape, so a reader never mistakes it for
// the page:
//   • no readiness-probe result — "connected" here means "you hold a `use`
//     grant on a live connection row", not "the connector's health probe says
//     the remote answered";
//   • no installed-extension / actor-visibility filtering of catalog rows —
//     every build-time catalog connector is listed, connected or not;
//   • no RUNTIME-ONLY connector (one installed at runtime with no build-time
//     catalog descriptor) — the result is strictly catalog-derived;
//   • no owner identity, no organization id, no connection counts for rows the
//     actor may not use, no per-connection grant material;
//   • no credential, token, secret ref, or raw Nango connection identifier.
//
// READING AN EMPTY ANSWER. `hasAuthorizedConnection: false` means "no
// connection YOU are authorized to use" — it never means "nobody has connected
// this". The tool description carries the same sentence, because the defect
// this ships against is an assistant implying the negative.
// ---------------------------------------------------------------------------

import type { ActorContext } from "@/lib/authz/actor-context";
import type { NangoConnectionIdentity } from "@cinatra-ai/extensions/connection-identity-store";

/**
 * ONE result row — the connector catalog entry plus the actor's authorized
 * connection state for it. Every field is model-facing; adding one is a
 * security decision pinned by the field-allowlist snapshot test.
 */
export type ConnectorInventoryRow = {
  /**
   * The host's stable connector identity — the catalog slug that addresses the
   * connector's own surface at `/connectors/<vendor>/<slug>`.
   */
  connectorKey: string;
  /** The connector's user-facing label (its own manifest name when it declares one). */
  displayName: string;
  /**
   * Whether the actor holds a `use` grant on at least one live connection for
   * this connector. FALSE means "none you may use" — never "none exist".
   */
  hasAuthorizedConnection: boolean;
  /**
   * The connection-identity ids the actor is authorized to `use`, POST
   * authorization. These are `nango_connection.id` values — the resource ids
   * the polymorphic permission tables grant against (`resource_kind`
   * `connection`), the same ids the connection-sharing surface addresses. They
   * are NOT the raw Nango connection identifier (the token-vault address) and
   * they are not credentials: every downstream use re-authorizes live.
   */
  authorizedConnectionIds: string[];
};

export type ConnectorInventoryResult = {
  connectors: ConnectorInventoryRow[];
};

/**
 * The FIELD ALLOWLIST. The projector below emits exactly these keys, in this
 * order, and the snapshot test fails on any addition — so a future edit cannot
 * widen the model-facing surface without a reviewer seeing it.
 */
export const CONNECTOR_INVENTORY_ROW_FIELDS = [
  "connectorKey",
  "displayName",
  "hasAuthorizedConnection",
  "authorizedConnectionIds",
] as const;

/** The allowlisted TOP-LEVEL result keys (same rule as the row fields). */
export const CONNECTOR_INVENTORY_RESULT_FIELDS = ["connectors"] as const;

/**
 * The one place a result row is built. Takes the catalog identity and the
 * ALREADY-AUTHORIZED ids — it cannot see a raw connection row, so it cannot
 * leak one. Keep this the only constructor of `ConnectorInventoryRow`.
 */
export function projectConnectorInventoryRow(input: {
  connectorKey: string;
  displayName: string;
  authorizedConnectionIds: string[];
}): ConnectorInventoryRow {
  return {
    connectorKey: input.connectorKey,
    displayName: input.displayName,
    hasAuthorizedConnection: input.authorizedConnectionIds.length > 0,
    authorizedConnectionIds: [...input.authorizedConnectionIds],
  };
}

/** A catalog connector, reduced to what the inventory needs. */
export type ConnectorInventoryCatalogEntry = {
  packageId: string;
  connectorKey: string;
  displayName: string;
};

/**
 * Injectable seams — production wiring lives in
 * {@link DEFAULT_CONNECTOR_INVENTORY_DEPS}. Tests drive the authorization
 * boundary directly through these.
 */
export type ConnectorInventoryDeps = {
  /** The TRUSTED actor for this invocation (MCP request frame first), or null. */
  resolveActor: () => Promise<{
    actor: ActorContext | null;
    subjectUserId: string | null;
    organizationId: string | null;
  }>;
  /** The build-time connector catalog. */
  listCatalog: () => Promise<ConnectorInventoryCatalogEntry[]>;
  /** The page's scope-filter reader — NOT actor-authorized; every row is gated below. */
  listConnectionRows: (
    organizationId: string | null,
    subjectUserId: string,
  ) => Promise<NangoConnectionIdentity[]>;
  /** The per-connection `use` decision. Non-throwing; a deny drops the row. */
  decideUse: (input: {
    identity: NangoConnectionIdentity;
    actor: ActorContext | undefined | null;
    subjectUserId: string | undefined;
  }) => Promise<{ allowed: boolean }>;
};

/**
 * Build the inventory for the CURRENT trusted actor.
 *
 * FAIL-CLOSED at every layer:
 *   • no trusted actor / no human subject ⇒ `{ connectors: [] }` (never the
 *     catalog with an implied state, never another tenant's rows);
 *   • a connection row whose `use` decision denies ⇒ DROPPED, so it can never
 *     reach the projector;
 *   • a `use` decision that THROWS ⇒ the row is dropped too (an evaluation
 *     fault is a deny, not a pass).
 */
export async function buildConnectorInventory(
  deps: ConnectorInventoryDeps,
): Promise<ConnectorInventoryResult> {
  const { actor, subjectUserId, organizationId } = await deps.resolveActor();
  if (!actor || !subjectUserId) return { connectors: [] };

  const rows = await deps.listConnectionRows(organizationId, subjectUserId);

  // PER-ROW AUTHORIZATION. `listConnectionRows` returned the org's live rows
  // plus the actor's own; only the subset the actor may `use` survives.
  const authorizedByPackageId = new Map<string, string[]>();
  await Promise.all(
    rows.map(async (identity) => {
      let allowed = false;
      try {
        allowed = (await deps.decideUse({ identity, actor, subjectUserId })).allowed;
      } catch {
        allowed = false; // an evaluation fault is a deny
      }
      if (!allowed) return;
      const ids = authorizedByPackageId.get(identity.connectorPackageId) ?? [];
      ids.push(identity.id);
      authorizedByPackageId.set(identity.connectorPackageId, ids);
    }),
  );

  const connectors = (await deps.listCatalog()).map((entry) =>
    projectConnectorInventoryRow({
      connectorKey: entry.connectorKey,
      displayName: entry.displayName,
      // Sorted so the same workspace state serializes identically turn to turn.
      authorizedConnectionIds: [...(authorizedByPackageId.get(entry.packageId) ?? [])].sort(),
    }),
  );

  return { connectors };
}

// ---------------------------------------------------------------------------
// Production wiring — imported lazily by the MCP module so the heavy host graph
// (pg pool, permissions store, catalog registry) is not pulled into the MCP
// server's module graph at registration time.
// ---------------------------------------------------------------------------

export const DEFAULT_CONNECTOR_INVENTORY_DEPS: ConnectorInventoryDeps = {
  resolveActor: async () => {
    // Identity comes from the TRUSTED request/run context — the same resolver
    // the connector host ports use, which reads the MCP request frame (and the
    // worker/A2A frame) rather than a cookie session. A chat-delegated call has
    // no cookie at all, so a cookie-only resolution would silently degrade to
    // "no actor" and this tool would answer for nobody.
    const { resolveExtensionActorContext, resolveExtensionActorSummary } = await import(
      "@/lib/extension-host-actor"
    );
    const [actor, summary] = await Promise.all([
      resolveExtensionActorContext(),
      resolveExtensionActorSummary(),
    ]);
    return {
      actor,
      subjectUserId: summary?.userId ?? null,
      organizationId: summary?.organizationId ?? null,
    };
  },
  listCatalog: async () => {
    // The build-time catalog, read through the HOST registry (the one place
    // that resolves a descriptor's host-side identity). `slug` is the stable
    // connector key — it addresses the connector's own surface — and
    // `displayName` is the catalog label the card falls back to.
    const { listConnectorRegistryEntries } = await import("@/lib/connectors-registry.server");
    return listConnectorRegistryEntries().map((entry) => ({
      packageId: entry.packageId,
      connectorKey: entry.slug,
      displayName: entry.displayName,
    }));
  },
  listConnectionRows: async (organizationId, subjectUserId) => {
    const { listNangoConnectionsForScopeFilter } = await import(
      "@cinatra-ai/extensions/connection-identity-store"
    );
    return listNangoConnectionsForScopeFilter(organizationId, subjectUserId);
  },
  decideUse: async (input) => {
    // The canonical per-connection `use` evaluator: owner short-circuit, the
    // polymorphic connection grant, and the connector's declared access-ceiling
    // clamp. Non-throwing and unaudited — the same call the resolver's
    // candidate discovery makes, which is exactly the list-filter posture.
    const { decideConnectionUse } = await import("@/lib/connection-use-gate");
    return decideConnectionUse(input);
  },
};

/** Build the inventory with the production wiring. */
export function buildConnectorInventoryForCurrentActor(): Promise<ConnectorInventoryResult> {
  return buildConnectorInventory(DEFAULT_CONNECTOR_INVENTORY_DEPS);
}
