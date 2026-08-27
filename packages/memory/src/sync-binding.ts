/**
 * The bundle sync binding (`sync:` in `bundle.yaml`) and the per-concept scope
 * request that overrides it.
 *
 * Two rules govern everything in this module, both fixed by epic #1373:
 *
 *  1. **A bundle is a distribution unit and a sync-time DEFAULT only.** The
 *     `sync:` block never grants anything. Its `ownerLevel` / `visibility`
 *     are the scope a sync run REQUESTS for rows it CREATES; the server
 *     re-derives defaults from the actor and re-authorizes the request. A
 *     bundle asking for a scope its syncing caller cannot satisfy is refused
 *     server-side, never silently downgraded.
 *
 *  2. **Bundle files are untrusted input.** This parser is strict on purpose:
 *     an unknown key, a wrong type, or an attempt to name a server-derived
 *     axis (`orgId`) is an ERROR, not a tolerated stray. Tolerant consumption
 *     is an OKF rule for CONCEPT frontmatter, not for the file that decides
 *     where a sync run writes.
 */
import {
  MemorySyncError,
  type MemoryConcept,
  type MemoryScopeOwnerLevel,
  type MemoryScopeRequest,
  type MemoryScopeVisibility,
  type MemorySyncBinding,
} from "./types.ts";

const OWNER_LEVELS: ReadonlySet<string> = new Set([
  "user",
  "team",
  "organization",
  "workspace",
]);

const VISIBILITIES: ReadonlySet<string> = new Set([
  "private",
  "team",
  "organization",
  "public",
]);

/** Keys the `sync:` block accepts. Anything else is refused. */
const SYNC_KEYS: ReadonlySet<string> = new Set([
  "projectId",
  "ownerLevel",
  "ownerId",
  "visibility",
]);

/**
 * Keys a bundle may NEVER carry, with the reason surfaced to the author.
 *
 * The organization axis is actor-derived on the server and no `objects_*`
 * primitive accepts it from a caller. A bundle that names one is either a
 * misunderstanding or a forgery attempt; either way, refusing loudly is the
 * only honest answer — dropping it silently would let the author believe the
 * sync landed somewhere it did not.
 */
const FORBIDDEN_SYNC_KEYS: ReadonlyMap<string, string> = new Map([
  [
    "orgId",
    "the organization is derived from the authenticated caller and is never read from a bundle file",
  ],
  [
    "organizationId",
    "the organization is derived from the authenticated caller and is never read from a bundle file",
  ],
  [
    "externalId",
    "the row's external identity is recomputed by the server from bundleId + conceptId",
  ],
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function readNonEmptyString(
  value: unknown,
  key: string,
  where: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MemorySyncError(`${where}: ${key} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Parse the `sync:` block out of an already-parsed `bundle.yaml` mapping.
 * Returns `undefined` when the bundle declares no block at all.
 */
export function parseMemorySyncBinding(
  doc: Record<string, unknown>,
  where = "bundle.yaml",
): MemorySyncBinding | undefined {
  const raw = doc["sync"];
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainRecord(raw)) {
    throw new MemorySyncError(`${where}: sync must be a YAML mapping`);
  }
  for (const key of Object.keys(raw)) {
    const forbidden = FORBIDDEN_SYNC_KEYS.get(key);
    if (forbidden !== undefined) {
      throw new MemorySyncError(`${where}: sync.${key} is not accepted — ${forbidden}`);
    }
    if (!SYNC_KEYS.has(key)) {
      throw new MemorySyncError(
        `${where}: unknown key sync.${key} (accepted: ${[...SYNC_KEYS].join(", ")})`,
      );
    }
  }
  const defaultScope: MemoryScopeRequest = {};
  if (raw["ownerLevel"] !== undefined) {
    const level = readNonEmptyString(raw["ownerLevel"], "sync.ownerLevel", where);
    if (!OWNER_LEVELS.has(level)) {
      throw new MemorySyncError(
        `${where}: sync.ownerLevel must be one of ${[...OWNER_LEVELS].join(", ")}`,
      );
    }
    defaultScope.ownerLevel = level as MemoryScopeOwnerLevel;
  }
  if (raw["visibility"] !== undefined) {
    const visibility = readNonEmptyString(raw["visibility"], "sync.visibility", where);
    if (!VISIBILITIES.has(visibility)) {
      throw new MemorySyncError(
        `${where}: sync.visibility must be one of ${[...VISIBILITIES].join(", ")}`,
      );
    }
    defaultScope.visibility = visibility as MemoryScopeVisibility;
  }
  if (raw["ownerId"] !== undefined) {
    defaultScope.ownerId = readNonEmptyString(raw["ownerId"], "sync.ownerId", where);
  }
  const binding: MemorySyncBinding = { defaultScope };
  if (raw["projectId"] !== undefined && raw["projectId"] !== null) {
    binding.projectId = readNonEmptyString(raw["projectId"], "sync.projectId", where);
  }
  return binding;
}

/**
 * Resolve the scope a sync run REQUESTS for one concept:
 * bundle default first, per-concept frontmatter over it.
 *
 * Frontmatter is CONCEPT content, so it is read tolerantly (an unusable value
 * is ignored rather than failing the whole run) — but it is still only a
 * request, evaluated under the caller's own authorization at save time. It
 * can never widen a row beyond what the caller could already write, and it is
 * only ever sent for a row this run CREATES.
 *
 * `orgId` in frontmatter is ignored here for the same reason the bundle block
 * refuses it: no objects primitive accepts an org from a caller, so a forged
 * value has nothing to bind to.
 */
export function resolveMemoryConceptScopeRequest(
  binding: MemorySyncBinding | undefined,
  concept: Pick<MemoryConcept, "frontmatter">,
): MemoryScopeRequest {
  const resolved: MemoryScopeRequest = { ...(binding?.defaultScope ?? {}) };
  const fm = concept.frontmatter;
  const level = fm["ownerLevel"];
  if (typeof level === "string" && OWNER_LEVELS.has(level)) {
    resolved.ownerLevel = level as MemoryScopeOwnerLevel;
  }
  const visibility = fm["visibility"];
  if (typeof visibility === "string" && VISIBILITIES.has(visibility)) {
    resolved.visibility = visibility as MemoryScopeVisibility;
  }
  const ownerId = fm["ownerId"];
  if (typeof ownerId === "string" && ownerId.trim() !== "") {
    resolved.ownerId = ownerId.trim();
  }
  return resolved;
}

/**
 * Rank a scope tuple so a run can tell an already-WIDER remote row apart from
 * an identical one — the check behind the `scope-preserved` diagnostic.
 *
 * The ranking is presentational only. Nothing in this library narrows a row:
 * a sync run never sends ownership/visibility for a row that already exists,
 * and `objects_save` refuses a scope change on a collision regardless.
 */
export function memoryVisibilityRank(visibility: string | undefined): number {
  switch (visibility) {
    case "private":
      return 0;
    case "team":
      return 1;
    case "organization":
      return 2;
    case "public":
      return 3;
    default:
      return -1;
  }
}
