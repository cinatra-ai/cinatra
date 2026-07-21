import "server-only";
import {
  objectTypeRegistry,
  matcherManifestRegistry,
} from "@cinatra-ai/objects/registry";

import { mimeAcceptedByAccepts, normalizeMime } from "./upload-artifact-type-map";
import {
  humanizeExtensionPackage,
  humanizeTypeLocalPart,
} from "./type-definitions-inventory";

// ---------------------------------------------------------------------------
// Installed-type picker candidates (epic #1883 slice A4, spec design@16efd8d2
// `specs/app-artifacts.html` §VI.1 — "The installed-type picker").
//
// After an upload's MIME base resolves (§VI, `upload-artifact-type-map`), the
// user MAY assert what the file MEANS. The picker admits installed,
// file-accepting MEANING SURFACES whose declared MIME set includes the DETECTED
// MIME — a user-sourced MEANING assertion, never a re-type (the format base is
// fixed; a PDF stays a PDF). The candidates come from TWO installed sources,
// UNIONED (cinatra#1892 A4-seam, over A3 cinatra#1891):
//
//   (1) OBJECT-TYPE channel — own-namespace artifact types
//       (`objectTypeRegistry.listArtifacts()`) whose `accepts.file.mimeTypes`
//       admit the MIME, keyed by the DEFINING extension. Carries a concrete
//       `objectTypeId` + specific local-part label ("Contract").
//   (2) MATCHER-MANIFEST channel (A3) — the meaning-surface registry
//       (`matcherManifestRegistry.list()`) whose `fileMimeTypes` admit the MIME,
//       keyed by the pack's PACKAGE NAME (the matcher assertion target string).
//       Post-#1785 a meaning pack registers NO own-namespace object type
//       accepting common MIMEs (its umbrella was retired), so WITHOUT this union
//       the picker's positive path is EMPTY for every installable meaning pack.
//       A manual pick over a matcher-channel candidate is the human doing what
//       the auto-matcher does above threshold — SAME assertion target
//       (`assertSemanticType({ extension: packageName, assertedBy:"user" })`),
//       consistent with the epic's auto-above-threshold / chip-below model.
//
// Both share the wildcard-aware `mimeAcceptedByAccepts` matcher and the
// universal-floor exclusion (a `*/*` catch-all is the retired default-artifact
// floor, never a meaning). A row with no defining package (object-type channel)
// is excluded — a meaning assertion is keyed on the extension. The UNION is
// DEDUPED BY `extension`: a pack that both defines an own-namespace artifact
// type AND declares matchers appears ONCE, preferring the object-type candidate
// (the more specific label + concrete type id). This module enumerates the raw
// candidates; the per-actor extension-ACCESS gate is applied by the caller
// (`upload-typing-actions`, the SAME `resolveActiveInstallForActor` gate the
// A6 presentation host resolves matcher-pack liveness through, so the picker's
// "offered" set and the resolver's "will-present" set agree — no dead picks).
// ---------------------------------------------------------------------------

/** One picker option: an installed file-accepting meaning surface accepting the
 *  MIME — either an own-namespace object type or a matcher-manifest pack. */
export type InstalledMeaningType = {
  /** The `@scope/package:local-id` object type id, or `null` for a
   *  matcher-manifest (package-keyed) meaning surface that mints no type. */
  objectTypeId: string | null;
  /** The extension package a user meaning assertion is written against
   *  (`assertSemanticType({ extension })`) — the DEFINING extension for an
   *  object-type candidate, the PACKAGE NAME for a matcher-manifest candidate. */
  extension: string;
  /** Humanized primary label — the type local part ("Contract") for an
   *  object-type candidate, the humanized package ("Brand Voice") for a
   *  matcher-manifest candidate. */
  displayName: string;
  /** Humanized defining-package / pack label ("Legal", "Brand Voice"). */
  extensionLabel: string;
};

/** One registry-read artifact type: its id, defining package (provenance), and
 *  declared `accepts.file.mimeTypes`. Injectable so selection is unit-testable
 *  without the global registry. */
export type RegisteredArtifactMeaningType = {
  objectTypeId: string;
  definer: string | null;
  acceptMimes: readonly string[] | undefined;
};

/** One matcher-manifest channel entry (A3 `MatcherManifestEntry` subset): the
 *  pack's package name and the file MIME forms it classifies over. Injectable so
 *  the union is unit-testable without the global matcher registry. */
export type MatcherChannelMeaningType = {
  packageName: string;
  fileMimeTypes: readonly string[];
};

function isUniversalAcceptEntry(accept: string): boolean {
  const a = accept.trim().toLowerCase();
  return a === "*/*" || a === "*";
}

/**
 * PURE core: select the installed file-accepting types whose `accepts` admit the
 * detected MIME. Excludes (a) types with no defining package (a meaning
 * assertion needs an extension key), (b) the universal catch-all floor, (c) a
 * caller-supplied `excludeTypeId` — the artifact's OWN resolved base type, since
 * re-asserting the format base as a meaning is a no-op the picker must not offer.
 * Alphabetical by display name (then extension) for a stable surface.
 */
export function selectMeaningTypesAcceptingMime(
  artifactTypes: readonly RegisteredArtifactMeaningType[],
  mime: string,
  opts?: { excludeTypeId?: string },
): InstalledMeaningType[] {
  const normalized = normalizeMime(mime);
  if (normalized.length === 0) return [];
  const out: InstalledMeaningType[] = [];
  for (const t of artifactTypes) {
    if (t.definer == null) continue;
    if (opts?.excludeTypeId && t.objectTypeId === opts.excludeTypeId) continue;
    const accepts = t.acceptMimes;
    if (!Array.isArray(accepts) || accepts.length === 0) continue;
    if (accepts.some(isUniversalAcceptEntry)) continue;
    if (!mimeAcceptedByAccepts(accepts, normalized)) continue;
    out.push({
      objectTypeId: t.objectTypeId,
      extension: t.definer,
      displayName: humanizeTypeLocalPart(t.objectTypeId),
      extensionLabel: humanizeExtensionPackage(t.definer),
    });
  }
  return sortMeaningTypes(out);
}

/**
 * PURE core: select the MATCHER-MANIFEST channel meaning surfaces (A3) whose
 * declared `fileMimeTypes` admit the detected MIME. Each entry is keyed by its
 * PACKAGE NAME (the matcher assertion target string), so the candidate's
 * `extension` IS the package name and `objectTypeId` is null (a matcher pack
 * mints no type). Same universal-catch-all exclusion as the object-type channel
 * (an any/any classify-everything pack is not a specific meaning). A
 * caller-supplied
 * `excludeExtension` (the artifact's own base-type definer) is dropped so a
 * matcher pack is never offered to re-assert the format base.
 */
export function selectMatcherChannelMeaningTypesAcceptingMime(
  channel: readonly MatcherChannelMeaningType[],
  mime: string,
  opts?: { excludeExtension?: string },
): InstalledMeaningType[] {
  const normalized = normalizeMime(mime);
  if (normalized.length === 0) return [];
  const out: InstalledMeaningType[] = [];
  for (const entry of channel) {
    if (opts?.excludeExtension && entry.packageName === opts.excludeExtension) {
      continue;
    }
    const accepts = entry.fileMimeTypes;
    if (!Array.isArray(accepts) || accepts.length === 0) continue;
    if (accepts.some(isUniversalAcceptEntry)) continue;
    if (!mimeAcceptedByAccepts(accepts, normalized)) continue;
    out.push({
      objectTypeId: null,
      extension: entry.packageName,
      displayName: humanizeExtensionPackage(entry.packageName),
      extensionLabel: humanizeExtensionPackage(entry.packageName),
    });
  }
  return sortMeaningTypes(out);
}

/**
 * PURE core: the UNION of object-type + matcher-manifest meaning candidates,
 * DEDUPED BY `extension`. A pack that appears in both channels (defines an
 * own-namespace artifact type AND declares matchers) is listed ONCE, preferring
 * the OBJECT-TYPE candidate (a concrete `objectTypeId` + specific local-part
 * label is more informative than the humanized package). Alphabetical by display
 * name (then extension) for a stable surface.
 *
 * `excludeExtension` (the artifact's own base-type DEFINING extension) drops
 * EVERY candidate for that extension across BOTH channels — not just the exact
 * base type id. A meaning assertion is keyed on the EXTENSION, so a MIME-
 * compatible SIBLING type from the base's own defining extension
 * (`@acme/legal:nda` when the base is `@acme/legal:contract`) or that extension's
 * matcher candidate would assert the SAME extension as the base's namespace owner
 * — a no-op the picker must not offer (codex seam-verdict finding 5).
 */
export function unionMeaningTypesAcceptingMime(
  objectTypeCandidates: readonly InstalledMeaningType[],
  matcherChannelCandidates: readonly InstalledMeaningType[],
  opts?: { excludeExtension?: string },
): InstalledMeaningType[] {
  const byExtension = new Map<string, InstalledMeaningType>();
  // Object-type candidates first — they win the dedup (concrete type id).
  for (const c of objectTypeCandidates) {
    if (opts?.excludeExtension && c.extension === opts.excludeExtension) continue;
    if (!byExtension.has(c.extension)) byExtension.set(c.extension, c);
  }
  for (const c of matcherChannelCandidates) {
    if (opts?.excludeExtension && c.extension === opts.excludeExtension) continue;
    if (!byExtension.has(c.extension)) byExtension.set(c.extension, c);
  }
  return sortMeaningTypes([...byExtension.values()]);
}

/** Stable surface order: alphabetical by display name, then by extension (a
 *  matcher candidate has no objectTypeId, so extension is the stable secondary
 *  key across both channels). */
function sortMeaningTypes(types: InstalledMeaningType[]): InstalledMeaningType[] {
  return types.sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      a.extension.localeCompare(b.extension),
  );
}

/**
 * Read the installed file-accepting meaning surfaces accepting the given MIME —
 * the UNION of the object-type registry (by provenance) and the matcher-manifest
 * channel (A3, by package name). The caller must have warmed the registries
 * (`registerAllObjectTypes()` + the matcher bridge). An uninstalled type/pack
 * simply contributes no option. `excludeTypeId` is the artifact's own resolved
 * base type: it excludes both the object-type candidate WITH that id AND a
 * matcher-channel candidate whose package is that type's DEFINING extension
 * (re-asserting the format base as a meaning is a no-op the picker must not
 * offer).
 */
export function listInstalledMeaningTypesAcceptingMime(
  mime: string,
  opts?: { excludeTypeId?: string },
): InstalledMeaningType[] {
  const artifactTypes: RegisteredArtifactMeaningType[] = objectTypeRegistry
    .listArtifacts()
    .map((def) => ({
      objectTypeId: def.type,
      definer: objectTypeRegistry.getRegisteringPackage(def.type),
      acceptMimes: def.isArtifact?.accepts?.file?.mimeTypes,
    }));
  const objectTypeCandidates = selectMeaningTypesAcceptingMime(
    artifactTypes,
    mime,
    opts,
  );
  // The base type's DEFINING extension — exclude EVERY union candidate for that
  // extension (object-type sibling OR matcher candidate), since asserting it
  // would re-assert the base's own namespace owner (a no-op).
  const excludeExtension = opts?.excludeTypeId
    ? objectTypeRegistry.getRegisteringPackage(opts.excludeTypeId) ?? undefined
    : undefined;
  const channel: MatcherChannelMeaningType[] = matcherManifestRegistry
    .list()
    .map((entry) => ({
      packageName: entry.packageName,
      fileMimeTypes: entry.fileMimeTypes,
    }));
  const matcherChannelCandidates = selectMatcherChannelMeaningTypesAcceptingMime(
    channel,
    mime,
  );
  return unionMeaningTypesAcceptingMime(
    objectTypeCandidates,
    matcherChannelCandidates,
    excludeExtension ? { excludeExtension } : undefined,
  );
}
