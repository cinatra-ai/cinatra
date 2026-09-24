/**
 * The objects_update seam of the deterministic passthrough (cinatra#3564).
 *
 * A flow's ApiNode renders every leaf of its request data as a string, so a
 * write-back that renders its patch through `tojson` hands `input.data` to the
 * passthrough as JSON text. This seam parses that text back into the record the
 * objects_update handler merges, and refuses anything that is not a plain JSON
 * object with a named error (the route's shaper-throw contract answers it with
 * HTTP 400). It never returns a string `data`, never coerces, never drops a key
 * and never adds one; a call without `data` (a project move) and a call whose
 * `data` is already a plain object pass through unchanged. Zero dependencies.
 */

export class ObjectsUpdateDataNotAnObjectError extends Error {
  constructor(kind: string) {
    super(`objects_update input.data must be a plain JSON object (got ${kind})`);
    this.name = "ObjectsUpdateDataNotAnObjectError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function shapeObjectsUpdateInput(raw: Record<string, unknown>): Record<string, unknown> {
  const data = raw.data;
  if (data === undefined || isPlainObject(data)) return raw;
  if (typeof data !== "string") throw new ObjectsUpdateDataNotAnObjectError(kindOf(data));
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new ObjectsUpdateDataNotAnObjectError("unparseable JSON text");
  }
  if (!isPlainObject(parsed)) throw new ObjectsUpdateDataNotAnObjectError(kindOf(parsed));
  return { ...raw, data: parsed };
}
