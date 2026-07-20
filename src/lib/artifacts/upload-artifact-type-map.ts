import "server-only";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { isPackageRequiredInProd } from "@cinatra-ai/extensions/required-in-prod";

// ---------------------------------------------------------------------------
// Upload MIME → required-base artifact type map (epic #1785, wave A3).
//
// The dynamic-types retirement removes the generic `@cinatra-ai/artifact:object`
// catch-all: every artifact row now carries its EXACT declared object type in
// `objects.type`, validated at the writer before any blob IO. The upload route
// and the URL-import path only know a MIME, so they must map that MIME to a
// concrete, installed artifact type SYNCHRONOUSLY — or REFUSE. The async LLM
// matcher that used to type an artifact AFTER it was persisted under the generic
// type is gone (it cannot type a row that must be typed at write time).
//
// THE MAP DOMAIN IS DERIVED, NOT HARDCODED (true-IoC — core-extension-instance-
// coupling-ban): core NEVER names a specific artifact pack. The domain is every
// installed `isArtifact` object type whose DEFINING package is REQUIRED-in-prod
// (the manifest-declared `cinatra.extensions` set — data, not a literal), read
// from the in-process object-type registry by provenance. Today that resolves to
// the base packs (pdf / audio / video / image); a third-party pack that also
// happens to accept `image/*` is NOT required and so cannot silently capture
// uploads, and a MIME no required type accepts (e.g. `text/markdown` from URL
// import) fails closed rather than landing under a fallback name.
//
// THE RETIRED GENERIC FLOOR IS EXCLUDED: a candidate whose `accepts.file` is the
// universal `*/*` (or bare `*`) catch-all is the retired default-artifact floor
// — it must NEVER participate in upload resolution (it would swallow every MIME
// and make the resolution ambiguous). Upload resolution maps only to DEDICATED,
// non-universal MIME homes; the floor is not an upload target.
//
// EXACTLY-ONE-OR-REFUSE: a MIME accepted by exactly one required base type
// resolves to that type; zero or more-than-one accepting types both REFUSE
// (fail closed).
// ---------------------------------------------------------------------------

export type UploadArtifactTypeCandidate = {
  objectTypeId: string;
  /** The candidate type's declared `accepts.file.mimeTypes`. */
  acceptMimes: readonly string[];
};

/**
 * The structured refusal class for an unresolvable upload MIME (cinatra#1890,
 * A2). Consumers (the upload route's advisory channel) must NOT parse the
 * human-readable `reason` string to decide recourse — they branch on `kind`:
 *   - `no_mime`    — the upload declared no MIME at all; "install a type" is
 *                    NOT the recourse (there is nothing to match on).
 *   - `no_type`    — a real MIME that no installed required-base type accepts;
 *                    THIS is the "install a type that accepts this" recourse
 *                    case that earns the marketplace deep-link advisory.
 *   - `ambiguous`  — more than one required-base type accepts the MIME; the
 *                    refusal is a fail-closed "refusing to guess", and installing
 *                    MORE types would make it worse — no install advisory.
 */
export type UploadTypeRefusalKind = "no_mime" | "no_type" | "ambiguous";

export type ResolveUploadArtifactTypeResult =
  | { ok: true; objectTypeId: string }
  | { ok: false; kind: UploadTypeRefusalKind; reason: string; matched: string[] };

/** Normalize a MIME for matching: drop parameters (`; charset=...`), trim, and
 *  lowercase. An empty/whitespace MIME normalizes to "". Exported so the
 *  refusal-advisory channel (cinatra#1890) keys its notification + deep link on
 *  the SAME normalized MIME the resolver refused on. */
export function normalizeMime(mime: string): string {
  const base = mime.split(";", 1)[0] ?? "";
  return base.trim().toLowerCase();
}

// Does a declared `accepts` entry match the (normalized) upload MIME?
//  - a "type/" wildcard (e.g. "image/" + "*") matches any subtype under `type`
//    ("image/*" ⊇ "image/png").
//  - a full "*" + "/*" wildcard matches anything (never declared by a base pack;
//    the retired generic catch-all — accepted here only for completeness).
//  - otherwise an exact, case-insensitive match.
function acceptMatches(accept: string, normalizedMime: string): boolean {
  const a = accept.trim().toLowerCase();
  if (a === "*/*") return true;
  if (a.endsWith("/*")) {
    const prefix = a.slice(0, a.length - 1); // keep the trailing slash: "image/"
    return normalizedMime.startsWith(prefix);
  }
  return a === normalizedMime;
}

/**
 * Whether a declared `accepts.file.mimeTypes` list accepts a MIME
 * (wildcard-aware). Exported so the writer can re-validate that a stream's
 * DETECTED MIME is within the resolved type's declared accepts (a client cannot
 * smuggle image bytes under an `application/pdf` declared type).
 */
export function mimeAcceptedByAccepts(
  acceptMimes: readonly string[],
  mime: string | undefined,
): boolean {
  const normalized = normalizeMime(mime ?? "");
  if (normalized.length === 0) return false;
  return acceptMimes.some((accept) => acceptMatches(accept, normalized));
}

/**
 * PURE core: given the candidate base-pack types (each with its accepts) and an
 * upload MIME, return the EXACTLY-ONE accepting object type, else refuse.
 * Injectable so the decision is unit-testable without the registry.
 */
export function resolveUploadArtifactTypeFromCandidates(
  mime: string | undefined,
  candidates: readonly UploadArtifactTypeCandidate[],
): ResolveUploadArtifactTypeResult {
  const normalized = normalizeMime(mime ?? "");
  if (normalized.length === 0) {
    return {
      ok: false,
      kind: "no_mime",
      reason:
        "no MIME on the upload — cannot map to a required-base artifact type",
      matched: [],
    };
  }
  const matched: string[] = [];
  for (const cand of candidates) {
    if (cand.acceptMimes.some((accept) => acceptMatches(accept, normalized))) {
      matched.push(cand.objectTypeId);
    }
  }
  // De-dupe (a single type could list the same MIME twice; two distinct types
  // both matching is the ambiguity case).
  const distinct = Array.from(new Set(matched));
  if (distinct.length === 1) {
    return { ok: true, objectTypeId: distinct[0] };
  }
  if (distinct.length === 0) {
    return {
      ok: false,
      kind: "no_type",
      reason:
        `no installed required-base artifact type accepts "${normalized}"`,
      matched: [],
    };
  }
  return {
    ok: false,
    kind: "ambiguous",
    reason:
      `MIME "${normalized}" is ambiguously accepted by more than one system-base ` +
      `artifact type [${distinct.join(", ")}] — refusing to guess`,
    matched: distinct,
  };
}

// Whether a single declared `accepts.file` entry is the UNIVERSAL catch-all
// (a bare "*" or the star/star "*"+"/*" pair) — the retired generic
// default-artifact floor. A TYPE wildcard ("image/*") is NOT universal and
// stays a legitimate dedicated home.
function isUniversalAcceptEntry(accept: string): boolean {
  const a = accept.trim().toLowerCase();
  return a === "*/*" || a === "*";
}

/** One installed `isArtifact` type as read from the registry: its id, the
 *  package that DEFINES it (provenance; `null` for a host/built-in), and its
 *  declared `accepts.file.mimeTypes`. */
export type RegisteredArtifactType = {
  objectTypeId: string;
  definer: string | null;
  acceptMimes: readonly string[] | undefined;
};

/**
 * PURE: select the upload-resolution candidates from every installed
 * `isArtifact` type. A type qualifies iff it (a) has a non-null defining
 * package, (b) that package is REQUIRED-in-prod (`isRequired`), (c) declares a
 * non-empty `accepts.file.mimeTypes`, and (d) is NOT the universal star/star
 * floor.
 * Injectable (`artifactTypes`, `isRequired`) so the selection is unit-testable
 * without the global registry or the on-disk required-set manifest.
 */
export function selectRequiredArtifactUploadCandidates(
  artifactTypes: readonly RegisteredArtifactType[],
  isRequired: (packageName: string) => boolean,
): UploadArtifactTypeCandidate[] {
  const out: UploadArtifactTypeCandidate[] = [];
  for (const t of artifactTypes) {
    if (t.definer == null || !isRequired(t.definer)) continue;
    const accepts = t.acceptMimes;
    if (!Array.isArray(accepts) || accepts.length === 0) continue;
    // Drop the retired generic floor (a `*/*` / `*` catch-all is not a
    // dedicated upload home — it would swallow every MIME).
    if (accepts.some(isUniversalAcceptEntry)) continue;
    out.push({ objectTypeId: t.objectTypeId, acceptMimes: accepts });
  }
  return out;
}

/**
 * Read the REQUIRED-in-prod artifact types' registered ids + accepts from the
 * in-process object-type registry (by provenance). The caller must have warmed
 * the registry (`registerAllObjectTypes()`); an unregistered / uninstalled /
 * non-required type simply contributes no candidate (its uploads then fail
 * closed at the map). No pack is named here — the required set is manifest data.
 */
export function readSystemBaseUploadCandidates(): UploadArtifactTypeCandidate[] {
  const artifactTypes: RegisteredArtifactType[] = objectTypeRegistry
    .listArtifacts()
    .map((def) => ({
      objectTypeId: def.type,
      definer: objectTypeRegistry.getRegisteringPackage(def.type),
      acceptMimes: def.isArtifact?.accepts?.file?.mimeTypes,
    }));
  return selectRequiredArtifactUploadCandidates(artifactTypes, isPackageRequiredInProd);
}

/**
 * Resolve an upload MIME to the exactly-one installed required-base artifact
 * type, or refuse (fail closed). Registry-driven; the caller warms the registry.
 */
export function resolveUploadArtifactType(
  mime: string | undefined,
): ResolveUploadArtifactTypeResult {
  return resolveUploadArtifactTypeFromCandidates(
    mime,
    readSystemBaseUploadCandidates(),
  );
}
