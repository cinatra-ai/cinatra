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

// ---------------------------------------------------------------------------
// Retired generic host object type (cinatra#2592).
// ---------------------------------------------------------------------------

/**
 * The retired generic host object type id. Owner ruling 2026-07-18 (epic
 * #1785, "types exist only by installation") reversed #1787's lossless
 * generic-object fallback: a save that resolves to this id is REFUSED at the
 * write boundary, never persisted (`packages/objects/src/mcp/handlers.ts`).
 * The type stays REGISTERED for READ back-compat (`objects_list { type:
 * "@cinatra-ai/objects:object", runId }` and any surviving historical row),
 * so it is not deregistered — but it must never be OFFERED as a forward
 * outcome: the classifier catalog (`packages/objects/src/classifier/index.ts`)
 * excludes it from the registered-type list a model is shown, and the write
 * path refuses it explicitly even at high confidence. Declared once, here, so
 * the two surfaces read the SAME id and cannot silently diverge (the mismatch
 * cinatra#2592 fixed: the classifier prompt used to promise this id as a safe
 * fallback the write path already rejected).
 */
export const GENERIC_OBJECT_TYPE_ID = "@cinatra-ai/objects:object" as const;

// ---------------------------------------------------------------------------
// The UNOWNED-TYPE REFUSAL, named (enabler 0.16 of `PLAN: Agents Lifecycle (C)`,
// cinatra#3028 / epic #3023, closing half of cinatra#2960).
//
// THE ENABLER, IN THE PLAN'S OWN WORDS: "The unowned-type refusal, at both ends:
// the save boundary refuses a type that no installed extension and not the host
// owns, with a named reason; and the compiler flags an agent whose steps save to
// a type it neither declares nor depends on — the dynamic-type namespace
// resolves nowhere by design."
//
// WHAT IT FIXES, IN THE PLAN'S OWN WORDS: "a run fails one frame after its gate
// with an opaque error because a host shaper saves an intermediate value under a
// type nothing defines."
//
// WHY HERE, AND WHY PURE. Two write boundaries refuse this class today and each
// composed its own prose: the artifact write path
// (`src/lib/artifacts/artifact-creation.ts`) and the `objects_save` primitive
// (`packages/objects/src/mcp/handlers.ts`). Two prose refusals are how a caller
// ends up parsing English to find out what happened — which is exactly the
// "opaque error" the defect names. One PURE classifier, in the leaf both
// boundaries already import, gives both the same CLOSED reason token, so a
// surface can branch on the reason instead of the sentence.
//
// PORT-INJECTED, so the classifier stays free of the registry graph: the caller
// passes the two registry questions it can already answer. Total — an
// adversarial id answers with a reason, never a throw.
// ---------------------------------------------------------------------------

/**
 * Why a type is not owned. A CLOSED token set: a surface may branch on it, and
 * a new member is a documented contract change, exactly like the write-boundary
 * error codes beside it.
 */
export type UnownedArtifactTypeReason =
  /** The reserved dynamic mint namespace. It resolves nowhere BY DESIGN, so this
   *  is the one reason that is a statement about the id itself rather than about
   *  what happens to be installed. */
  | "dynamic-namespace"
  /** A retired host generic type id. Registered for READ back-compat, never a
   *  forward write target. */
  | "retired-generic"
  /** Not namespaced under a defining extension (`@scope/pkg:local`), so no
   *  extension could own it and the host does not. */
  | "not-namespaced"
  /** Namespaced, but no installed extension defines it. */
  | "no-installed-definer"
  /** Defined, but the definition is not an artifact write target (a plain data
   *  type: neither self-registered as an artifact nor carrying the
   *  `artifact-safe` projection disposition). */
  | "not-artifact-writable";

export const UNOWNED_ARTIFACT_TYPE_REASONS: readonly UnownedArtifactTypeReason[] = [
  "dynamic-namespace",
  "retired-generic",
  "not-namespaced",
  "no-installed-definer",
  "not-artifact-writable",
] as const;

/** The two registry questions the classifier needs, injected so this leaf
 *  imports no registry. */
export interface ArtifactTypeOwnershipPorts {
  /** Is the type registered AND an artifact write target? `null` when the type
   *  resolves to nothing at all; `false` when it resolves to a plain data type. */
  isArtifactWritable(typeId: string): boolean | null;
  /** Has the named package registered ANY type in this process? Drives the
   *  "install this extension" hint — a package that has registered types is
   *  installed, so suggesting its install would be a lie. */
  packageHasRegisteredTypes(pkg: string): boolean;
}

export type ArtifactTypeOwnership =
  | { owned: true; definer: string }
  | {
      owned: false;
      reason: UnownedArtifactTypeReason;
      /** The package the id NAMES as its definer, when the id is namespaced.
       *  Null when nothing can be named — never invented. */
      definer: string | null;
      /** The definer to suggest installing, present ONLY when a concrete,
       *  currently-uninstalled definer is known. */
      suggestedExtension: string | null;
    };

/** The defining extension package of a namespaced object-type id
 *  (`@scope/pkg:local` → `@scope/pkg`). Null for a non-namespaced id. */
export function definerPackageOfObjectTypeId(typeId: string): string | null {
  if (typeof typeId !== "string" || !typeId.startsWith("@")) return null;
  const colon = typeId.lastIndexOf(":");
  return colon > 0 ? typeId.slice(0, colon) : null;
}

/**
 * Classify a type at a write boundary: owned by an installed artifact extension
 * (or by the host), or unowned WITH A NAMED REASON.
 *
 * ORDER IS LOAD-BEARING, because more than one reason can be true at once and
 * the FIRST is the honest one. The reserved dynamic namespace and the retired
 * generic are statements about the id — they hold whatever is installed — so
 * they are answered before anything is asked of the registry; a caller told
 * "no installed extension defines it" about `@dynamic/types:x` would go looking
 * for an extension to install that can never exist.
 */
export function classifyArtifactTypeOwnership(
  typeId: string,
  ports: ArtifactTypeOwnershipPorts,
): ArtifactTypeOwnership {
  const unowned = (
    reason: UnownedArtifactTypeReason,
    definer: string | null,
    suggestedExtension: string | null = null,
  ): ArtifactTypeOwnership => ({ owned: false, reason, definer, suggestedExtension });

  if (typeof typeId !== "string" || typeId.length === 0) {
    return unowned("not-namespaced", null);
  }
  if (isTombstonedObjectTypeId(typeId)) {
    return unowned("dynamic-namespace", null);
  }
  if (typeId === GENERIC_OBJECT_TYPE_ID || typeId === "@cinatra-ai/artifact:object") {
    return unowned("retired-generic", null);
  }
  const definer = definerPackageOfObjectTypeId(typeId);
  if (!definer || !isNamespacedObjectTypeId(typeId)) {
    return unowned("not-namespaced", definer);
  }
  const writable = ports.isArtifactWritable(typeId);
  if (writable === null) {
    return unowned(
      "no-installed-definer",
      definer,
      ports.packageHasRegisteredTypes(definer) ? null : definer,
    );
  }
  if (writable === false) return unowned("not-artifact-writable", definer);
  return { owned: true, definer };
}

/**
 * The refusal SENTENCE for a named reason. The message is derived FROM the
 * reason, never composed beside it, so the two can never disagree — the failure
 * mode cinatra#2960 recorded, where the sentence said "no installed artifact
 * extension defines it" about an id that by design resolves nowhere.
 */
export function unownedArtifactTypeMessage(
  typeId: string,
  ownership: Extract<ArtifactTypeOwnership, { owned: false }>,
): string {
  const named = typeId ? `"${typeId}"` : "this content";
  switch (ownership.reason) {
    case "dynamic-namespace":
      return `${named} is in the reserved dynamic-type namespace, which resolves to no extension by design — a save must name a type an installed artifact extension declares`;
    case "retired-generic":
      return `the generic host object type ${named} is retired — a save must name an installed artifact extension's declared type`;
    case "not-namespaced":
      return `object type ${named} is not namespaced under a defining extension`;
    case "no-installed-definer":
      return ownership.suggestedExtension
        ? `no installed artifact extension defines ${named}; install ${ownership.suggestedExtension}`
        : `no installed artifact extension defines ${named}`;
    case "not-artifact-writable":
      return `${named} is a data type, not an artifact write target — its extension declares no artifact for it`;
  }
}
