// Host-owned NEUTRAL inline-preview surface (cinatra#1630 AC-3) — the single
// reuse slot that replaces the scattered in-core inline-image reuse sites (the
// dashboard binary-prompt baseline; formerly the dead SavedMedia variant).
//
// It renders a passive HTML element for a CAPABILITY-GATED preview href, chosen by
// the MIME's TRANSPORT CLASS — host safe-transport policy, NOT a concrete MIME
// allowlist and NOT by importing any extension renderer code. The dependency arrow
// stays extension→core: the image extension REGISTERS the `preview` representation
// provider that makes a MIME inline-eligible (which is what mints `previewHref`
// upstream); the host merely reads that capability and draws neutral pixels. When
// no provider is effective (e.g. the image base is archived) `previewHref` is null
// and this fails closed to the core fallback. Host/portlet React owns this surface;
// no extension pixels are imported (`"use client"`-safe, purely presentational).
//
// The current reuse sites are inline-IMAGE previews, so the `image` transport class
// draws an <img> and every other class (or a null href) draws the neutral core
// fallback. Extend the switch when a non-image reuse site appears.

export type ArtifactInlinePreviewProps = {
  /** The capability-gated preview URL (server-minted only when the selected
   * representation is inline-eligible), or null ⇒ render the core fallback. */
  previewHref: string | null;
  /** The SELECTED representation's MIME — used only to pick the passive element by
   * transport class (never to decide eligibility; that is `previewHref`). */
  mime: string;
  title?: string | null;
  /** Optional class override for the rendered media element. */
  className?: string;
};

/** The transport class (top-level MIME type) the passive element is chosen by. */
function transportClassOf(mime: string): string {
  const slash = mime.indexOf("/");
  return slash > 0 ? mime.slice(0, slash) : mime;
}

export function ArtifactInlinePreview({
  previewHref,
  mime,
  title,
  className,
}: ArtifactInlinePreviewProps) {
  if (previewHref && transportClassOf(mime) === "image") {
    // The preview-safe route serves session-gated, capped bytes; next/image
    // optimization would bypass those session-gated route semantics.
    return (
      // eslint-disable-next-line @next/next/no-img-element -- session-gated capped route bytes; next/image would bypass the route semantics
      <img
        src={previewHref}
        alt={title ?? "Artifact preview"}
        className={
          className ??
          "max-h-64 w-auto self-start rounded-md border border-line object-contain"
        }
      />
    );
  }
  // Core fallback (fail-closed): no effective inline-preview capability for this
  // representation, or a class the neutral slot does not inline.
  return (
    <div
      className="flex h-24 w-full items-center justify-center rounded-md border border-line bg-surface-muted text-xs text-muted-foreground"
      aria-label="No inline preview available"
    >
      No inline preview available
    </div>
  );
}
