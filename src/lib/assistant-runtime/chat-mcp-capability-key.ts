// ---------------------------------------------------------------------------
// Capability-key derivation for the chat self-MCP catalog (cinatra#2771).
//
// THE QUESTION. Given a servable primitive name, which connector's authorized
// connection gates it — if any?
//
// THE ANSWER IS THE LIVE CATALOG, NOT A TABLE. Every connector descriptor
// declares `mcpPrimitivePrefixes` (`gmail-connector` -> `["gmail_"]`), which
// is precisely the primitive-name-space that connector owns. A connector
// added tomorrow gates its own primitives with no code change here, and a
// primitive matching no catalog prefix is never gated.
//
// WHY NOT THE CONNECTOR KEY. The key is a SLUG (`gmail-connector`); primitives
// are underscore-named (`gmail_aliases_list`). Matching a primitive against
// the key admits nothing — no name is ever prefixed with a slug — so a
// key-based derivation silently gates NOTHING and hands every actor the whole
// list. That is the defect this module exists to make impossible.
//
// LONGEST PREFIX WINS. Prefixes may nest (`google_` vs `google_calendar_`),
// so the most specific declaration decides and the result is independent of
// catalog order. Ties on length are broken by connector key so the derivation
// is total and deterministic rather than order-dependent; a catalog that
// declares the SAME prefix on two connectors is a catalog defect, and picking
// arbitrarily would make it unreproducible instead of merely wrong.
//
// The returned key is the CONNECTOR KEY, because that is what the availability
// set is keyed by — the same `connectorKey` the inventory row carries.
// ---------------------------------------------------------------------------

/** The catalog identity this derivation needs — one inventory row's worth. */
export type CapabilityKeySource = {
  connectorKey: string;
  mcpPrimitivePrefixes?: readonly string[];
};

/**
 * Build the primitive-name -> capability-key resolver for a catalog.
 *
 * Returns `null` for a name no catalog prefix claims: NOT GATED, which keeps
 * host/platform primitives (`connector_inventory_list`, `projects_list`)
 * reachable without a connection, exactly as before.
 */
export function buildCapabilityKeyResolver(
  catalog: readonly CapabilityKeySource[],
): (primitiveName: string) => string | null {
  // Flattened to (prefix, key) pairs once, then ordered longest-first so
  // `find` below returns the most specific match. Empty prefixes are dropped:
  // `""` prefixes every name and would gate the entire catalog on one
  // connector.
  const ordered = catalog
    .flatMap((entry) =>
      (entry.mcpPrimitivePrefixes ?? [])
        .filter((prefix) => typeof prefix === "string" && prefix.length > 0)
        .map((prefix) => ({ prefix, connectorKey: entry.connectorKey })),
    )
    .sort(
      (a, b) =>
        b.prefix.length - a.prefix.length || a.connectorKey.localeCompare(b.connectorKey),
    );

  return (primitiveName: string): string | null =>
    ordered.find((entry) => primitiveName.startsWith(entry.prefix))?.connectorKey ?? null;
}
