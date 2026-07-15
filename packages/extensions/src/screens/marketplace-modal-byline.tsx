import Link from "next/link";

import { extensionKindEmblem } from "@/components/extension-kind-emblem";
import { safeHttpUrl, type MarketplaceDetailView } from "@/lib/marketplace-detail-view";
import {
  resolveVendorPresentation,
  VENDOR_BY_CONNECTIVE,
  VENDOR_MISSING_LABEL,
} from "@/lib/vendor-presentation";

/**
 * The §V detail-modal "{Type} by {Vendor}" byline (design spec §V), extracted
 * from `MarketplaceDetailModal` so the vendor-label rendering is a pure,
 * independently-testable unit (cinatra#1528): a 14px kind emblem in the accent,
 * the "{Type}" kind label in ink, and the vendor label.
 *
 * The vendor label comes ONLY from `resolveVendorPresentation` — this surface
 * never falls back to the vendor slug (the retired `name || slug` substitution).
 * A `known` vendor renders as a semibold primary link out to its
 * scheme-guarded store (plain text when no valid `storeUrl`); a `missing`
 * vendor renders the localized placeholder as PLAIN, unlinked text — never a
 * slug, and never a silently dropped "by" clause.
 */
export function MarketplaceModalByline({
  kindSlug,
  kindLabel,
  vendor,
  accentColor,
  packageName,
}: {
  kindSlug: Parameters<typeof extensionKindEmblem>[0];
  kindLabel: string;
  vendor: MarketplaceDetailView["vendor"];
  /** The extension's stable accent colour, applied to the kind emblem. */
  accentColor: string;
  /** Diagnostic-only locator for the missing-vendor diagnostic; never rendered. */
  packageName: string;
}) {
  const resolved = resolveVendorPresentation(
    { name: vendor?.name, storeUrl: vendor?.storeUrl },
    { surface: "marketplace-detail-modal", ref: packageName },
  );
  const storeUrl = resolved.kind === "known" ? safeHttpUrl(resolved.storeUrl) : null;
  const vendorLabel = resolved.kind === "known" ? resolved.displayName : VENDOR_MISSING_LABEL;

  return (
    <p
      data-slot="marketplace-modal-byline"
      data-vendor-state={resolved.kind}
      className="flex items-center gap-1.25 text-sm text-muted-foreground"
    >
      <span aria-hidden="true" className="shrink-0" style={{ color: accentColor }}>
        {extensionKindEmblem(kindSlug, "size-3.5")}
      </span>
      <span className="min-w-0 truncate">
        {/* data-slot: conformance stable-id contract (cinatra#986) — §V byline
            kind label (per-kind state variant assertions). */}
        <span data-slot="marketplace-modal-kind" className="text-foreground">
          {kindLabel}
        </span>
        {` ${VENDOR_BY_CONNECTIVE} `}
        {storeUrl ? (
          <Link
            href={storeUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-slot="marketplace-modal-vendor-label"
            className="font-semibold text-primary hover:underline hover:underline-offset-2"
          >
            {vendorLabel}
          </Link>
        ) : (
          <span
            data-slot="marketplace-modal-vendor-label"
            className="font-semibold text-foreground"
          >
            {vendorLabel}
          </span>
        )}
      </span>
    </p>
  );
}
