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
