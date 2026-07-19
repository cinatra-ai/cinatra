import "server-only";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

// ---------------------------------------------------------------------------
// Upload MIME → system-base artifact type map (epic #1785, wave A3).
//
// The dynamic-types retirement removes the generic `@cinatra-ai/artifact:object`
// catch-all: every artifact row now carries its EXACT declared object type in
// `objects.type`, validated at the writer before any blob IO. The upload route
// and the URL-import path only know a MIME, so they must map that MIME to a
// concrete, installed artifact type SYNCHRONOUSLY — or REFUSE. The async LLM
// matcher that used to type an artifact AFTER it was persisted under the generic
// type is gone (it cannot type a row that must be typed at write time).
//
// The map domain is the four REQUIRED system-base artifact packs (pdf / audio /
// video / image). They are the guaranteed-installed base that gives an arbitrary
// binary upload a typed home by MIME. Scoping the map to exactly these four (and
// reading each one's declared type + accepts FROM THE REGISTRY by provenance)
// keeps the resolution unambiguous: a third-party pack that also happens to
// accept `image/*` cannot silently capture uploads, and a MIME no base pack
// accepts (e.g. `text/markdown` from URL import) fails closed rather than
// landing under a fallback name.
//
// EXACTLY-ONE-OR-REFUSE: a MIME accepted by exactly one base-pack type resolves
// to that type; zero or more-than-one accepting types both REFUSE (fail closed).
// ---------------------------------------------------------------------------

/**
 * The four REQUIRED system-base artifact packs. Each declares exactly one
 * dedicated artifact-safe object type (`:document` / `:recording` / `:video` /
 * `:image`) plus its pack-level `accepts.file.mimeTypes`. The concrete type id
 * and accepted MIMEs are read from the in-process registry by provenance — this
 * list only fixes the SET of packs the upload map is allowed to resolve into.
 */
export const SYSTEM_BASE_ARTIFACT_PACKS: readonly string[] = [
  "@cinatra-ai/pdf-artifact",
  "@cinatra-ai/audio-artifact",
  "@cinatra-ai/video-artifact",
  "@cinatra-ai/image-artifact",
] as const;

export type UploadArtifactTypeCandidate = {
  objectTypeId: string;
  /** The candidate type's declared `accepts.file.mimeTypes`. */
  acceptMimes: readonly string[];
};

export type ResolveUploadArtifactTypeResult =
  | { ok: true; objectTypeId: string }
  | { ok: false; reason: string; matched: string[] };

/** Normalize a MIME for matching: drop parameters (`; charset=...`), trim, and
 *  lowercase. An empty/whitespace MIME normalizes to "". */
function normalizeMime(mime: string): string {
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
      reason:
        "no MIME on the upload — cannot map to a system-base artifact type (pdf/audio/video/image)",
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
      reason:
        `no installed system-base artifact pack (pdf/audio/video/image) accepts "${normalized}"`,
      matched: [],
    };
  }
  return {
    ok: false,
    reason:
      `MIME "${normalized}" is ambiguously accepted by more than one system-base ` +
      `artifact type [${distinct.join(", ")}] — refusing to guess`,
    matched: distinct,
  };
}

/**
 * Read the four REQUIRED system-base packs' registered artifact types +
 * accepts from the in-process object-type registry (by provenance). The caller
 * must have warmed the registry (`registerAllObjectTypes()`); an unregistered /
 * uninstalled base pack simply contributes no candidate (its uploads then fail
 * closed at the map).
 */
export function readSystemBaseUploadCandidates(): UploadArtifactTypeCandidate[] {
  const out: UploadArtifactTypeCandidate[] = [];
  for (const pkg of SYSTEM_BASE_ARTIFACT_PACKS) {
    for (const typeId of objectTypeRegistry.getTypesForPackage(pkg)) {
      const def = objectTypeRegistry.resolve(typeId);
      const accepts = def?.isArtifact?.accepts?.file?.mimeTypes;
      if (!def?.isArtifact || !Array.isArray(accepts) || accepts.length === 0) {
        continue;
      }
      out.push({ objectTypeId: typeId, acceptMimes: accepts });
    }
  }
  return out;
}

/**
 * Resolve an upload MIME to the exactly-one installed system-base artifact type,
 * or refuse (fail closed). Registry-driven; the caller warms the registry.
 */
export function resolveUploadArtifactType(
  mime: string | undefined,
): ResolveUploadArtifactTypeResult {
  return resolveUploadArtifactTypeFromCandidates(
    mime,
    readSystemBaseUploadCandidates(),
  );
}
