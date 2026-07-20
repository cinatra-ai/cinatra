// ---------------------------------------------------------------------------
// Namespace validation
// ---------------------------------------------------------------------------

/**
 * Validates that an object type ID is in `@scope/package:local-id` format.
 * Mirrors the `RENDERER_NAMESPACE_RE` pattern used by fieldRendererRegistry
 * so object type IDs and field renderer IDs share a single, predictable
 * namespace convention.
 */
export const OBJECT_TYPE_NAMESPACE_RE = /^@[\w-]+\/[\w-]+:[\w-]+$/;

/**
 * Returns true when `id` matches the canonical `@scope/package:local-id`
 * namespace format.
 */
export function isNamespacedObjectTypeId(id: string): boolean {
  return OBJECT_TYPE_NAMESPACE_RE.test(id);
}

// ---------------------------------------------------------------------------
// Dynamic-type id scope (cinatra#1425, epic #1424).
//
// NEW dynamic-type ids mint under the RESERVED, NON-VENDOR `@dynamic` scope —
// `@dynamic/types:<slug>` — so an LLM-proposed type never squats a real
// vendor's namespace. The legacy first-party-prefixed ids
// (`@cinatra-ai/dynamic:<slug>`) predate the reservation and STAY VALID via
// the catalog (existing rows keep their ids; both prefixes classify/read) —
// only MINTING moved.
// ---------------------------------------------------------------------------

/** The scope+package prefix new dynamic-type ids mint under. */
export const DYNAMIC_TYPE_ID_PREFIX = "@dynamic/types:";

/** Legacy first-party dynamic prefix — READ/classify back-compat only; never
 * minted anymore. */
export const LEGACY_DYNAMIC_TYPE_ID_PREFIX = "@cinatra-ai/dynamic:";

export const DYNAMIC_TYPE_ID_RE = /^@dynamic\/types:[a-z0-9-]+$/;
export const LEGACY_DYNAMIC_TYPE_ID_RE = /^@cinatra-ai\/dynamic:[a-z0-9-]+$/;

/** True for ANY dynamic-type id — the reserved `@dynamic` scope or the legacy
 * first-party prefix. Survives the engine teardown (epic cinatra#1785 entry 95;
 * #1793) as the READ / tombstone-rejection predicate ONLY: existing rows keep
 * their ids and both prefixes still classify/read, while the forward-looking
 * write surfaces reject. The `mintDynamicObjectTypeId` helper that once minted
 * NEW ids under this scope was DELETED with the teardown — no path may mint a
 * new dynamic-type id (the tombstone below makes that permanent). */
export function isDynamicObjectTypeId(id: string): boolean {
  return DYNAMIC_TYPE_ID_RE.test(id) || LEGACY_DYNAMIC_TYPE_ID_RE.test(id);
}

// ---------------------------------------------------------------------------
// PERMANENT namespace tombstones (cinatra#1789, epic #1785).
//
// The two dynamic-type prefixes above are PERMANENTLY RETIRED as forward WRITE
// targets: no artifact-claim manifest, no extension object-type registration
// (including a derived `<pkg>:artifact` umbrella id), and no direct claim-store
// write may ever mint, claim, or register a NEW type id under either prefix
// again. Existing rows keep their ids and both prefixes still classify/read
// (above) — only the forward-looking write surfaces reject. Minting DELETION
// happens elsewhere (#1787, #1790) and the retirement migration in #1792 runs
// on this substrate; THIS is the permanence guarantee that makes the legacy
// label durable — the namespaces can never come back.
//
// `TOMBSTONED_OBJECT_TYPE_ID_PREFIXES` is the SINGLE canonical declaration of
// the tombstone set. The two rejection sites that cannot import this module —
// the pure claims policy leaf (keeps its zero-non-zod-imports invariant) and
// the host `extension-edge-bound-serving` lib (importing @cinatra-ai/objects
// would widen the locked route graph, which is shrink-only) — inline a mirror
// pinned byte-equal to this array by test (`namespace-tombstones.test.ts`,
// `extension-edge-bound-serving.test.ts`).
// ---------------------------------------------------------------------------

/** The PERMANENTLY-tombstoned object-type id prefixes — the reserved dynamic
 * mint scope and the legacy first-party dynamic prefix. Matched PREFIX-EXACT:
 * an id under either prefix is tombstoned (including a malformed/empty slug or
 * the derived `@dynamic/types:artifact` umbrella), while a look-alike scope
 * such as `@dynamics/types:x` is NOT. */
export const TOMBSTONED_OBJECT_TYPE_ID_PREFIXES = [
  DYNAMIC_TYPE_ID_PREFIX,
  LEGACY_DYNAMIC_TYPE_ID_PREFIX,
] as const;

/** True when `id` falls under a PERMANENTLY-tombstoned dynamic namespace and
 * must be rejected at every forward write surface (artifact-claim manifest
 * validation, extension object-type registration, claim-store write). Broader
 * than `isDynamicObjectTypeId` on purpose: that predicate is a STRICT
 * well-formed-slug match (read/classify back-compat); this one is prefix-exact,
 * so a reserved-scope id with a malformed or empty slug — or the derived
 * `@dynamic/types:artifact` umbrella — is still rejected and can never sneak a
 * row into a tombstoned namespace. */
export function isTombstonedObjectTypeId(id: string): boolean {
  return (
    typeof id === "string" &&
    TOMBSTONED_OBJECT_TYPE_ID_PREFIXES.some((prefix) => id.startsWith(prefix))
  );
}
