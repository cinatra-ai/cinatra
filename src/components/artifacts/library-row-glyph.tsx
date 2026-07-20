import "server-only";
/**
 * Library-row glyph — resolved through the artifact-UI dispatch spine
 * (S7/M2, cinatra#1631; epic #1620). The per-extension-family glyph map that
 * used to live host-side in library-mode.tsx (list→ListIcon,
 * mail/outreach/email→Mail) is DELETED: a claimed row's glyph now resolves via
 * the claiming extension's registered `listRow` capability (the S1 manifest
 * slot activated by this wave, arbitrated by the winner-bound semantic
 * registry), and every claimed row whose winner ships no built `listRow`
 * renderer falls to the GENERIC claimed glyph. The file-vs-structured floor
 * split (FileText / Braces) is the host-side generic floor and stays.
 *
 * Failure containment mirrors the detail spine (AC-4): pre-render load
 * failures (never-built, absent, invalid export, ABI mismatch, quarantined)
 * degrade SILENTLY to the generic claimed glyph (the loader logs the sanitized
 * diagnostic); a present-but-broken module throws to the route-segment error
 * boundary and is quarantined after repeat failures. A runtime-installed
 * claimant absent from this build (the dynamic path is client-only; row glyphs
 * are SSR) renders the generic claimed glyph — never blank.
 */
import type { ReactNode } from "react";
import { Boxes, Braces, FileText } from "lucide-react";

import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import { loadArtifactRenderer } from "@/lib/artifacts/artifact-renderer-loader";
import {
  ARTIFACT_RENDERER_PROPS_API_VERSION,
  buildArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";
import {
  classifyLoadablePath,
  resolveSemanticListRowDispatch,
} from "@/app/artifacts/[id]/renderer-resolution";

/** The file-vs-structured floor split (host-side, stays): a concrete MIME is a
 * file representation; the octet-stream default reads as structured data. */
export function isFileMime(mime: string): boolean {
  return Boolean(mime) && mime !== "application/octet-stream";
}

/** The host cell tint classes per glyph tier (the cell chrome stays host-side;
 * an extension `listRow` renderer draws only the glyph CONTENT inside it). */
function glyphTier(summary: ArtifactSummary): {
  className: string;
  Fallback: typeof FileText;
} {
  if (summary.presentationIdentity.kind === "extension") {
    return { className: "bg-primary/10 text-primary", Fallback: Boxes };
  }
  if (isFileMime(summary.mime)) {
    return { className: "bg-warning/10 text-warning", Fallback: FileText };
  }
  return { className: "bg-surface-muted text-muted-foreground", Fallback: Braces };
}

/**
 * The library row's glyph cell (§II identity line, design@4c6799d). Async
 * server component: for a claimed row it resolves the winner's `listRow`
 * capability through the semantic registry + the generated build map (SSR
 * fast path) and mounts the extension-shipped glyph; every other state —
 * unclaimed row, winner without a `listRow` renderer, runtime-only (not in
 * this build) claimant, or a pre-render load failure — renders the host's
 * generic glyph for its tier. Never blank.
 */
export async function LibraryRowGlyph({
  summary,
}: {
  summary: ArtifactSummary;
}): Promise<ReactNode> {
  const { className, Fallback } = glyphTier(summary);
  // Row labeling presents the assertion-aware PRESENTATION identity (epic
  // #1883 A6): the winner's `listRow` glyph resolves for the presented type.
  const identity = summary.presentationIdentity;

  let extensionGlyph: ReactNode = null;
  if (identity.kind === "extension") {
    const resolved = resolveSemanticListRowDispatch(summary.objectType, identity);
    if (
      resolved &&
      // Defensive winner-binding (mirrors the pure dispatch leaf): the resolved
      // claimant must BE the row's effective-identity winner.
      resolved.packageName === identity.extension &&
      resolved.built &&
      // Row glyphs are SSR-only: the dynamic (runtime-URL) path is client-only
      // and out of scope for the row surface — it floors to the generic glyph.
      classifyLoadablePath(resolved.generatedKey) === "build-map"
    ) {
      const result = await loadArtifactRenderer({
        generatedKey: resolved.generatedKey,
        packageName: resolved.packageName,
        slot: "listRow",
        expectedPropsApiVersion: ARTIFACT_RENDERER_PROPS_API_VERSION,
      });
      if (result.ok) {
        const props = buildArtifactRendererProps({
          artifact: summary,
          representation: null,
          previewHref: null,
          downloadHref: null,
        });
        const { Component } = result;
        extensionGlyph = <Component {...props} />;
      }
      // A failed load falls through to the generic claimed glyph — the loader
      // already logged the sanitized diagnostic (silent floor for a 34px cell).
    }
  }

  // Never-blank is STRUCTURAL (Codex finding, cinatra#1631): a valid extension
  // component may legally render null/empty, which would otherwise leave an
  // empty cell. The host fallback icon is always present underneath and is
  // shown by CSS exactly when the extension wrapper rendered no DOM
  // (`peer-empty`) — the floor cannot be un-rendered by extension output.
  return (
    <span
      className={`grid size-[34px] flex-none place-items-center overflow-hidden rounded-lg ${className}`}
      data-testid="artifacts-library-glyph"
      data-glyph-source={extensionGlyph ? "extension" : "generic"}
    >
      {extensionGlyph ? (
        <>
          <span className="peer col-start-1 row-start-1 grid place-items-center">
            {extensionGlyph}
          </span>
          <Fallback
            aria-hidden
            className="col-start-1 row-start-1 hidden size-[17px] peer-empty:block"
          />
        </>
      ) : (
        <Fallback aria-hidden className="size-[17px]" />
      )}
    </span>
  );
}
