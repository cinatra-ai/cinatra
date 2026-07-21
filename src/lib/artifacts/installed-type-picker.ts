import "server-only";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

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
// user MAY assert what the file MEANS. The picker admits ONLY installed,
// file-accepting artifact types whose declared `accepts.file.mimeTypes` include
// the DETECTED MIME — a user-sourced MEANING assertion over those types, never a
// re-type (the format base is fixed; a PDF stays a PDF). This module enumerates
// exactly those candidate types from the in-process object-type registry.
//
// DIFFERENCE FROM `upload-artifact-type-map` (base typing): the base map is the
// REQUIRED-in-prod format roster (exactly-one-or-refuse). The picker is BROADER
// — every installed file-accepting artifact type accepting the MIME, required or
// not (a third-party meaning pack like `@acme/legal:contract` is a legitimate
// meaning even though it is not required-in-prod). The two share only the
// wildcard-aware `mimeAcceptedByAccepts` matcher and the universal-floor
// exclusion (a `*/*` catch-all is the retired default-artifact floor, never a
// meaning). A type with no defining package is excluded — a meaning assertion is
// keyed on the DEFINING extension (`assertSemanticType`), so a provenance-less
// host built-in cannot be asserted.
// ---------------------------------------------------------------------------

/** One picker option: an installed file-accepting type accepting the MIME. */
export type InstalledMeaningType = {
  /** The `@scope/package:local-id` object type id. */
  objectTypeId: string;
  /** The DEFINING extension package — the key a user meaning assertion is
   *  written against (`assertSemanticType({ extension })`). */
  extension: string;
  /** Humanized local part — the primary label ("Contract"). */
  displayName: string;
  /** Humanized defining-package label ("Legal"). */
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
 * Alphabetical by display name (then type id) for a stable surface.
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
  out.sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      a.objectTypeId.localeCompare(b.objectTypeId),
  );
  return out;
}

/**
 * Read the installed file-accepting artifact types accepting the given MIME from
 * the in-process object-type registry (by provenance). The caller must have
 * warmed the registry (`registerAllObjectTypes()`). An uninstalled type simply
 * contributes no option.
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
  return selectMeaningTypesAcceptingMime(artifactTypes, mime, opts);
}
