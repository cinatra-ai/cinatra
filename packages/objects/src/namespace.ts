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
 * first-party prefix. */
export function isDynamicObjectTypeId(id: string): boolean {
  return DYNAMIC_TYPE_ID_RE.test(id) || LEGACY_DYNAMIC_TYPE_ID_RE.test(id);
}

/** Mint a new dynamic-type id under the reserved scope. */
export function mintDynamicObjectTypeId(slug: string): string {
  return `${DYNAMIC_TYPE_ID_PREFIX}${slug}`;
}
