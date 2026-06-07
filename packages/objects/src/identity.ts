import "server-only";
import { createHash } from "node:crypto";
import { objectTypeRegistry } from "./registry";

/**
 * Layered identity resolution:
 *
 * 1. external_id field on the data object (strongest — explicit external key)
 * 2. identityKey function on the type definition (canonical field extraction)
 * 3. Returns null if neither is available (caller falls through to insert-new)
 *
 * The resulting hash is used as an attribute filter against Graphiti
 * `/retrieve/search` to locate an existing entity before insert (dedup).
 */
export function resolveIdentity(type: string, data: unknown): string | null {
  // Layer 1: explicit external_id wins over everything
  const dataObj = data as Record<string, unknown> | null;
  if (dataObj && typeof dataObj === "object") {
    const externalId = dataObj["external_id"] ?? dataObj["externalId"];
    if (typeof externalId === "string" && externalId.trim() !== "") {
      return hashIdentity(type, `external:${externalId.trim()}`);
    }
  }

  // Layer 2: canonical key extraction via type's identityKey function
  const def = objectTypeRegistry.resolve(type);
  if (!def || !def.identityKey) return null;
  let raw: string | null;
  try {
    raw = def.identityKey(data as never);
  } catch {
    return null;
  }
  if (raw == null || raw.trim() === "") return null;
  return hashIdentity(type, raw);
}

/**
 * Exported for tests and diagnostics. Production code should call
 * `resolveIdentity` which also normalizes the type + data pair.
 */
export function hashIdentity(type: string, key: string): string {
  return createHash("sha256")
    .update(`${type} ${key.trim().toLowerCase()}`)
    .digest("base64url");
}
